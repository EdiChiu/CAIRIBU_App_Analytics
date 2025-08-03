// populate-events.js

const admin   = require("firebase-admin");
const axios   = require("axios");
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

const EVENTS_URL = "https://cairibu.urology.wisc.edu/events-listing/";

async function scrapeAndPopulate() {
  console.log("Fetching events page…");
  const { data: html, status } = await http.get(EVENTS_URL);
  if (status !== 200) throw new Error(`Unexpected HTTP status: ${status}`);
  console.log("Page fetched, parsing…");

  const $ = cheerio.load(html);
  const items = $("li.uw-event");
  console.log(`Found ${items.length} events in HTML.`);

  const events = [];
  items.each((_, el) => {
    const $el = $(el);

    const title = $el.find(".uw-event-title a").text().trim();
    if (!title) return;

    const times     = $el.find(".uw-event-listing > p span time");
    const startDate = times.eq(0).attr("datetime");
    if (!startDate) return;
    const endDate = times.eq(1).attr("datetime") || null;

    // Extract the time after '@' for EDT time
    const timeAfterAtText = $el.find(".uw-event-listing > p span").text();
    const timeAfterAtMatch = timeAfterAtText.match(/@\s*(.*?EDT\s*\-\s*.*?EDT)/);
    const timeAfterAt = timeAfterAtMatch ? timeAfterAtMatch[0].trim() : "";

    let location = $el
      .find(".uw-event-listing > p")
      .first()
      .clone()
      .find("span, a, br")
      .remove()
      .end()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    // Append the time to the location if available
    location = timeAfterAt ? `${timeAfterAt} ${location}`.trim() : location;

    // “More Information” link from event title
    const moreInfoUrl = $el
      .find(".uw-event-title a")
      .attr("href") || null;

    // NEW: Zoom link (detect any anchor whose text contains “zoom”)
    const zoomLink = $el
      .find(".uw-event-listing > p a")
      .filter((_, a) => /zoom/i.test($(a).text()))
      .attr("href") || "";

    const description = $el.find(".uw-event-excerpt p").text().trim();

    // Build your object, including zoomLink
    const evt = {
      title,
      date:        startDate,
      location,
      description,
      type:        "meeting",
      zoomLink,                       // <-- newly added field
    };
    if (endDate)     evt.endDate     = endDate;
    if (moreInfoUrl) evt.moreInfoUrl = moreInfoUrl;

    events.push(evt);
  });

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
      writeBatch.set(db.collection("events").doc(), e);
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
