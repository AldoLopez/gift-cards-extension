# Setup

Reminders work as soon as the extension is loaded. Only Gmail scanning needs the Google steps, and only one person has to do them.

## Load the extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this project folder.
3. Check that the extension ID is `lpmfdpedjiimimcfohodbbbjjkihkgjp`. The `key` in `manifest.json` keeps it the same on every computer.

Sam does the same on their computer, using a copy of this folder.

## Connect Gmail (one-time Google setup)

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and create a project, for example "Gift card reminder".
2. Under **APIs & Services > Library**, enable the **Gmail API**.
3. Under **Google Auth Platform**, configure the consent screen:
   - Audience: **External**, left in **Testing**.
   - Add both Gmail addresses (yours and Sam's) as **test users**.
   - Add the scope `https://www.googleapis.com/auth/gmail.readonly`.
4. Under **Clients**, create a client of type **Chrome Extension**, and enter `lpmfdpedjiimimcfohodbbbjjkihkgjp` as the Item ID.
5. Copy the client ID into `manifest.json`, replacing `REPLACE_WITH_YOUR_CLIENT_ID.apps.googleusercontent.com`.
6. Reload the extension at `chrome://extensions`.
7. Open the extension's **Settings** and click **Connect Gmail**.

Each person connects from their own Chrome profile. The scanned account is the one signed in to that profile, and it must be a listed test user.

Google shows an "app isn't verified" warning, because this is a private app in test mode. Continue past it for your own project.

### If it asks you to reconnect

Google can expire access for apps in test mode, possibly weekly. The extension notifies you and shows **Reconnect Gmail**. Your cards and balances aren't affected.

## What gets scanned

Only emails from stores you hold a card for, with subjects like "order" or "receipt", sent after the card was added. Message text is read inside the extension and isn't sent anywhere else.

## Adding a store that receipts don't parse for

Receipt layouts vary by retailer. If a receipt isn't picked up, add a sample of its text to `tests/receipt-parser.test.js` and adjust the patterns in `src/lib/receipt-parser.js`. Remove your personal details from the sample first.
