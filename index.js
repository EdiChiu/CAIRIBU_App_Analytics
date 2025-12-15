// populate-events.js

const admin = require("firebase-admin");
const axios = require("axios");
const ical = require("node-ical");
const cheerio = require("cheerio");

// 1) Replace with your downloaded key filename:
const serviceAccount = require("./serviceAccountKey.json");

// 2) Initialize the Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// 3) Axios instance with desktop‐like headers
const http = axios.create({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/115.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9," +
      "image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://cairibu.urology.wisc.edu/",
  },
});

// Public Google Calendar (.ics) feed for the calendar in the embed link.
// Calendar ID extracted from:
// https://calendar.google.com/calendar/u/0/embed?src=<CALENDAR_ID>
const CALENDAR_ID =
  "a25c65a0f44d5190d933872283a17c48d1fa153697f18e2c5c35e0d03742ac94@group.calendar.google.com";
// Public ICS feed URL (no auth needed for public calendars)
const CALENDAR_ICS_URL = `https://calendar.google.com/calendar/ical/${encodeURIComponent(
  CALENDAR_ID
)}/public/basic.ics`;

function formatDateOnly(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatEndDateOnly(ev) {
  if (!ev || !ev.end) return null;
  // For all-day events, iCal end is typically exclusive. Convert to inclusive end date.
  if (ev.datetype === "date" && ev.end instanceof Date) {
    const inclusive = new Date(ev.end);
    inclusive.setDate(inclusive.getDate() - 1);
    return formatDateOnly(inclusive);
  }
  return formatDateOnly(ev.end);
}

function firstUrlInText(text) {
  if (!text) return "";
  const match = String(text).match(/https?:\/\/[^\s)\]}>,]+/i);
  return match ? match[0] : "";
}

function computeTypeFromTitle(title) {
  return /\bcairibu\b/i.test(title) ? "CAIRIBU" : "External";
}

function normalizeAttendeesField(attendees) {
  // Public calendars typically don't expose attendees.
  // Preserve any provided list if present, otherwise omit.
  if (!attendees) return null;
  if (Array.isArray(attendees)) return attendees;
  return null;
}

function cleanDescriptionToText(input) {
  if (!input) return "";
  const raw = String(input);

  // If it doesn't look like HTML, just normalize whitespace a bit.
  if (!/[<>]/.test(raw)) return raw.replace(/\s+/g, " ").trim();

  // Preserve some structure before stripping tags.
  let html = raw
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*p\s*>/gi, "\n")
    .replace(/<\s*p\b[^>]*>/gi, "");

  // Collect href URLs so we don't lose links when converting to text.
  const $ = cheerio.load(html, { decodeEntities: true });
  const hrefs = [];
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (href && /^https?:\/\//i.test(href)) hrefs.push(href);
  });

  // Get visible text.
  let text = $.text();

  // Append unique hrefs that aren't already present in the text.
  const uniqHrefs = Array.from(new Set(hrefs));
  const missing = uniqHrefs.filter((u) => !text.includes(u));
  if (missing.length) {
    text = `${text}\n${missing.join("\n")}`;
  }

  // Normalize whitespace while keeping newlines.
  text = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trimEnd())
    .join("\n")
    .trim();

  return text;
}

async function scrapeAndPopulate() {
  console.log("Fetching public Google Calendar (.ics)…");
  const { data: icsText, status } = await http.get(CALENDAR_ICS_URL, {
    headers: {
      Accept: "text/calendar,text/plain;q=0.9,*/*;q=0.8",
    },
  });
  if (status !== 200) throw new Error(`Unexpected HTTP status: ${status}`);
  console.log("Calendar fetched, parsing…");

  // node-ical can parse raw ICS text
  const parsed = ical.parseICS(icsText);
  const vevents = Object.values(parsed).filter((c) => c && c.type === "VEVENT");
  console.log(`Found ${vevents.length} VEVENTs in calendar.`);

  const events = [];
  for (const ev of vevents) {
    const title = (ev.summary || "").trim();
    if (!title) continue;

    const startDate = formatDateOnly(ev.start);
    if (!startDate) continue;

    const endDate = formatEndDateOnly(ev);

    const description = cleanDescriptionToText(ev.description || "");
    const location = (ev.location || "").trim();

    const moreInfoUrl = ev.url ? String(ev.url) : null;

    // Try to extract a Zoom link from description or location
    const zoomLink =
      (/zoom/i.test(description) ? firstUrlInText(description) : "") ||
      (/zoom/i.test(location) ? firstUrlInText(location) : "") ||
      "";

    const type = computeTypeFromTitle(title);

    const evt = {
      title,
      date: startDate,
      location,
      description,
      type,
      zoomLink,
    };
    if (endDate) evt.endDate = endDate;
    if (moreInfoUrl) evt.moreInfoUrl = moreInfoUrl;

    // Preserve UID if present for stable document IDs
    if (ev.uid) evt.sourceUid = String(ev.uid);

    const attendees = normalizeAttendeesField(ev.attendee);
    if (attendees) evt.attendees = attendees;

    events.push(evt);
  }

  console.log("Replacing Firestore `events` collection…");
  // Delete all old docs
  const oldDocs = await db.collection("events").listDocuments();
  if (oldDocs.length) {
    const delBatch = db.batch();
    oldDocs.forEach(d => delBatch.delete(d));
    await delBatch.commit();
    console.log(`Deleted ${oldDocs.length} old documents.`);
  }

  // Write new ones
  if (events.length) {
    const writeBatch = db.batch();
    events.forEach((e) => {
      // Use a stable doc ID when possible to avoid churn between runs.
      const docRef = e.sourceUid
        ? db.collection("events").doc(String(e.sourceUid).replace(/\//g, "_"))
        : db.collection("events").doc();
      writeBatch.set(docRef, e);
    });
    await writeBatch.commit();
    console.log(`Wrote ${events.length} new documents.`);
  } else {
    console.log("No events to write!");
  }
}

scrapeAndPopulate()
  .then(() => {
    console.log("Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Error:", err.stack || err);
    process.exit(1);
  });
