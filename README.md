# CAIRIBU App Analytics — Deployment

This repo contains `streamlit_signup_chart.py`, a Streamlit dashboard that reads users, events, and profiles from Firestore.

Quick checklist to deploy on Streamlit Cloud:

- Ensure `requirements.txt` lists required packages (already contains `streamlit`, `firebase-admin`, `pandas`, `python-dateutil`, `altair`, `google-cloud-firestore`).
- Add your Firebase service account JSON to Streamlit Secrets as `firebase_service_account` (recommended) or set env var `FIREBASE_SERVICE_ACCOUNT` with the JSON string.
- Push this repo to GitHub and create a new app on Streamlit Cloud pointing at `streamlit_signup_chart.py`.

Local testing

1. Install dependencies:

```bash
python -m pip install -r requirements.txt
```

2. For local secrets, create `.streamlit/secrets.toml` (DO NOT commit it) and paste your service account JSON as shown in `.streamlit/secrets.toml.example`.

3. Run Streamlit:

```bash
streamlit run streamlit_signup_chart.py
```

Streamlit Cloud setup

1. Push your code to a GitHub repo. Example:

```bash
git add .
git commit -m "Add analytics dashboard"
git push origin main
```

2. On https://share.streamlit.io create a new app, connect your GitHub repo, and set the main file to `streamlit_signup_chart.py`.

3. In the Streamlit app settings → Secrets, add a new secret named `firebase_service_account` and paste the entire service account JSON value (or add `FIREBASE_SERVICE_ACCOUNT` env var with the JSON string). Streamlit Cloud accepts a JSON object or a JSON string.

Permissions

Make sure the service account you generated has at least Firestore read permissions (e.g., `roles/datastore.viewer` or the minimum custom role that permits reading documents).

Troubleshooting

- If the app errors about credentials, re-generate the key and re-paste the full JSON. Ensure no characters are truncated.
- Check Streamlit Cloud logs (App → Logs) for stack traces and error messages.
- If Firestore returns no documents, verify the service account's project id matches the Firestore project and that the `users` and `events` collections exist.

If you want, I can:

- Create the `.gitignore` and local secrets template (done).
- Walk through committing and pushing to GitHub from this machine.
- Provide step-by-step Streamlit Cloud UI instructions while you paste the secret.
