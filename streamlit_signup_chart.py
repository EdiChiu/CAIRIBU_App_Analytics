import streamlit as st
import pandas as pd
import datetime
from dateutil import parser
import os
import json

# Firebase Admin SDK for Python
import firebase_admin
from firebase_admin import credentials, firestore

st.set_page_config(page_title="Signup Timeline", layout="wide")


def get_service_account_cred():
    """Return a firebase_admin.credentials.Certificate loaded from:
    1) `st.secrets['firebase_service_account']` (Streamlit Cloud recommended)
    2) `FIREBASE_SERVICE_ACCOUNT` env var containing the JSON string
    3) Local file `serviceAccountKey.json` (fallback for local dev only)
    """
    # 1) Streamlit secrets (on Streamlit Cloud this can be a dict or JSON string)
    try:
        sa = st.secrets.get("firebase_service_account")
    except Exception:
        sa = None

    if sa:
        if isinstance(sa, dict):
            return credentials.Certificate(sa)
        try:
            return credentials.Certificate(json.loads(sa))
        except Exception:
            # fallthrough to next option
            pass

    # 2) Environment variable (JSON string)
    sa_env = os.environ.get("FIREBASE_SERVICE_ACCOUNT") or os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if sa_env:
        try:
            return credentials.Certificate(json.loads(sa_env))
        except Exception:
            pass

    # 3) Local file fallback (dev only)
    return credentials.Certificate("serviceAccountKey.json")

@st.cache_data(ttl=300)
def load_users():
    try:
        cred = get_service_account_cred()
    except Exception as e:
        st.error("Service account credential not available or invalid: {}".format(e))
        return pd.DataFrame()

    try:
        # initialize_app can only be called once per process
        if not firebase_admin._apps:
            firebase_admin.initialize_app(cred)
    except Exception:
        # Already initialized or initialization failed
        pass

    db = firestore.client()

    rows = []
    try:
        docs = db.collection("users").stream()
    except Exception as e:
        st.error(f"Error reading Firestore users collection: {e}")
        return pd.DataFrame()

    for d in docs:
        data = d.to_dict() or {}
        ts = data.get("profileCreatedAt") or data.get("profile_createdAt") or data.get("createdAt") or data.get("profileCreated")
        display_name = data.get("displayName") or data.get("display_name") or data.get("name") or data.get("fullName") or None
        dt = None
        if ts is None:
            # skip if no timestamp
            continue
        # Firestore Timestamp in the python client is a datetime.datetime
        try:
            if hasattr(ts, 'seconds') and hasattr(ts, 'nanoseconds'):
                # google.cloud.firestore_v1._helpers.Timestamp-like
                dt = datetime.datetime.fromtimestamp(ts.seconds)
            elif isinstance(ts, datetime.datetime):
                dt = ts
            elif isinstance(ts, (int, float)):
                # Could be seconds or milliseconds
                if ts > 1e12:
                    dt = datetime.datetime.fromtimestamp(ts / 1000)
                else:
                    dt = datetime.datetime.fromtimestamp(ts)
            elif isinstance(ts, str):
                try:
                    dt = parser.parse(ts)
                except Exception:
                    dt = None
        except Exception:
            dt = None

        if dt is None:
            continue

        rows.append({"uid": d.id, "datetime": dt, "displayName": display_name})

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    df["datetime"] = pd.to_datetime(df["datetime"])
    df["date"] = df["datetime"].dt.date
    return df


def make_chart(df_counts):
    import altair as alt
    df_counts = df_counts.reset_index()
    df_counts["date"] = pd.to_datetime(df_counts["date"]).dt.date
    chart = (
        alt.Chart(df_counts)
        .mark_bar()
        .encode(
            x=alt.X("date:T", title="Date", axis=alt.Axis(format="%Y-%m-%d")),
            y=alt.Y("count:Q", title="Signups"),
            tooltip=[alt.Tooltip("date:T", title="Date"), alt.Tooltip("count:Q", title="Signups")],
        )
        .properties(width=800, height=400)
    )
    return chart


def load_events_attendees():
    """Load events and attendee info from Firestore.

    Tries common field names for title and attendees.
    Returns list of dicts with eventID, title, attendee_count, attendee_names.
    """
    try:
        if not firebase_admin._apps:
            cred = get_service_account_cred()
            firebase_admin.initialize_app(cred)
    except Exception:
        pass

    db = firestore.client()
    rows = []
    try:
        docs = db.collection("events").stream()
    except Exception:
        return rows

    for d in docs:
        data = d.to_dict() or {}
        title = data.get("title") or data.get("name") or data.get("eventTitle") or ""

        attendees_field = None
        for f in ["attendees", "attendeeIds", "registered", "registrations", "attendeesList", "rsvps"]:
            if f in data:
                attendees_field = data.get(f)
                break

        attendee_count = 0
        attendee_names = []

        if isinstance(attendees_field, list):
            attendee_count = len(attendees_field)
            for item in attendees_field:
                if isinstance(item, dict):
                    name = item.get("displayName") or item.get("name") or item.get("display_name")
                    attendee_names.append(name or item.get("uid") or str(item))
                else:
                    attendee_names.append(str(item))
        elif isinstance(attendees_field, dict):
            # map-like {uid: true}
            attendee_count = len(attendees_field)
            attendee_names = list(map(str, attendees_field.keys()))
        elif isinstance(attendees_field, (int, float)):
            attendee_count = int(attendees_field)
        elif attendees_field:
            attendee_names = [str(attendees_field)]
            attendee_count = 1

        rows.append({
            "eventID": d.id,
            "title": title,
            "attendee_count": attendee_count,
            "attendee_names": ", ".join(attendee_names[:100]) if attendee_names else "",
        })

    return rows


def load_user_profiles():
    """Load user profiles and specified analytics fields from Firestore.

    Returns a DataFrame with columns: uid, displayName, attendedEventsAmount,
    commentAmount, institution, likeAmount, postAmount, profileOpens
    """
    try:
        if not firebase_admin._apps:
            cred = get_service_account_cred()
            firebase_admin.initialize_app(cred)
    except Exception:
        pass

    db = firestore.client()
    rows = []
    try:
        docs = db.collection("users").stream()
    except Exception:
        return pd.DataFrame()

    for d in docs:
        data = d.to_dict() or {}
        uid = d.id
        display_name = data.get("displayName") or data.get("display_name") or data.get("name") or data.get("fullName") or ""
        institution = data.get("institution") or data.get("org") or data.get("organization") or ""

        def to_int_field(key):
            v = data.get(key, 0)
            try:
                if v is None:
                    return 0
                if isinstance(v, (int, float)):
                    return int(v)
                return int(float(v))
            except Exception:
                return 0

        attended = to_int_field("attendedEventsAmount")
        comments = to_int_field("commentAmount")
        likes = to_int_field("likeAmount")
        posts = to_int_field("postAmount")
        opens = to_int_field("profileOpens")

        rows.append({
            "uid": uid,
            "displayName": display_name,
            "institution": institution,
            "attendedEventsAmount": attended,
            "commentAmount": comments,
            "likeAmount": likes,
            "postAmount": posts,
            "profileOpens": opens,
        })

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    # ensure numeric dtypes
    for c in ["attendedEventsAmount", "commentAmount", "likeAmount", "postAmount", "profileOpens"]:
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0).astype(int)
    return df

def main():
    st.title("CAIRIBU App Analytics Dashboard")

    df = load_users()
    if df.empty:
        st.info("No user timestamps found in Firestore or error occurred.")
        return

    # Total signups KPI
    total_signups = len(df)
    st.subheader("Overview")
    col1, col2 = st.columns([1, 3])
    col1.metric("Total signups", total_signups)

    min_date = df["date"].min()
    max_date = df["date"].max()

    date_range = st.date_input("Select date range", value=(min_date, max_date), min_value=min_date, max_value=max_date)
    if isinstance(date_range, tuple) and len(date_range) == 2:
        start, end = date_range
    else:
        start = date_range
        end = date_range

    # filter
    mask = (df["date"] >= start) & (df["date"] <= end)
    df_filtered = df.loc[mask]

    # aggregate counts and list of display names per date
    grouped = df_filtered.groupby("date").agg(
        count=("uid", "count"),
        names=("displayName", lambda s: ", ".join(sorted({n for n in s if n})))
    )

    if grouped.empty:
        st.warning("No signups in the selected range.")
    else:
        st.subheader("Signups per day")
        # chart expects a Series or DataFrame with date and count
        chart = make_chart(grouped["count"])
        st.altair_chart(chart, width='stretch')
        # show table with names
        table = grouped.reset_index().rename(columns={"date": "Date", "count": "Signups", "names": "Display Names"})
        st.write(table)

    # --- Events and attendees ---
    st.markdown("---")
    st.subheader("Events & Attendees")
    events = load_events_attendees()
    if not events:
        st.info("No events or attendee data found in Firestore 'events' collection.")
    else:
        ev_table = pd.DataFrame(events)
        # reorder columns for readability
        ev_table = ev_table[["eventID", "title", "attendee_count", "attendee_names"]]
        ev_table = ev_table.rename(columns={"attendee_count": "Attendee Count", "attendee_names": "Attendees"})
        st.write(ev_table)

        # --- User profiles table ---
        st.markdown("---")
        st.subheader("User Profiles")
        profiles_df = load_user_profiles()
        if profiles_df.empty:
            st.info("No user profile analytics found in `users` collection.")
        else:
            display_cols = [
                "displayName",
                "institution",
                "attendedEventsAmount",
                "commentAmount",
                "likeAmount",
                "postAmount",
                "profileOpens",
            ]
            df_show = profiles_df.set_index("uid")[display_cols]
            st.dataframe(df_show)

    if st.button("Reload data", key="reload_main"):
        # clear cache and reload
        st.cache_data.clear()
        st.experimental_rerun()

    st.markdown("---")

if __name__ == "__main__":
    main()
