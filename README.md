# GRAM NAMES SHOP — Firebase starter

A GitHub Pages storefront and Firebase-backed admin panel for Telegram username inventory.

## Features
- Public storefront reads active inventory from Cloud Firestore.
- Email/password admin login.
- Server-side admin authorization using Firebase custom claims.
- Add/edit usernames, prices, categories and statuses.
- Soft delete (archive) and restore.
- CSV upload preview; invalid rows are shown before import.
- Bulk import skips existing usernames.
- CSV export of current inventory.
- Audit log for changes.
- USD prices, optional until the admin sets them. Blank prices show “Price not set”.
- Storefront displays up to 50 usernames per page with Previous/Next navigation.

## Important security model
- Browser Firebase config is public by design. It is not a credential.
- Firestore rules deny all client writes.
- Cloud Functions verify the Firebase ID token's `admin: true` custom claim.
- Set the first admin from a trusted local environment using `scripts/set-admin.js`.
- NEVER upload a service-account JSON key to GitHub or put it in browser code.
- This starter does not include payment processing or Telegram ownership verification.

## 1. Create Firebase project
1. In Firebase Console, create a project.
2. Add a Web App and copy its config.
3. Enable **Authentication → Email/Password**.
4. Create a Firestore database.
5. Upgrade to the **Blaze** plan if required for Cloud Functions deployment. Check current Firebase pricing before enabling billing.
6. Install Node.js (current supported LTS), Firebase CLI and sign in:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use --add
   ```

## 2. Configure the frontend
Edit `firebase-config.js` and replace every `YOUR_*` value with the Firebase Web App config. This config is intended to be public; security comes from rules and server authorization.

## 3. Install and deploy functions/rules
From this project folder:
```bash
cd functions
npm install
cd ..
firebase deploy --only firestore:rules,functions
```
If your CLI asks for a region, this starter uses `us-central1`. Keep frontend and function region aligned.

## 4. Create the first admin safely
Create the admin user in Firebase Console → Authentication → Add user (email + strong unique password). Copy the user's UID.
Set Application Default Credentials for a trusted local environment, or use a service-account file stored OUTSIDE this repository:
```bash
# macOS/Linux example; never commit this file
export GOOGLE_APPLICATION_CREDENTIALS="/secure/path/service-account.json"
node scripts/set-admin.js ADMIN_UID
```
On Windows PowerShell:
```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\secure\service-account.json"
node scripts/set-admin.js ADMIN_UID
```
The service account used here needs permission to set Firebase Authentication custom claims. Do not expose it to the browser. After setting the claim, sign out and back in (or force-refresh the ID token).

## 5. Deploy website to GitHub Pages
1. Put the project files in your repository (for example `fhweb3/gramnames-shop`).
2. In GitHub, enable Pages for the intended branch/folder.
3. Ensure `index.html`, `admin.html`, `firebase-config.js`, `app.js`, and `styles.css` are at the published root.
4. Firebase authorized domains: Authentication → Settings → Authorized domains. Add your GitHub Pages hostname (e.g. `fhweb3.github.io`), and test the deployed URL.

## CSV format
Header row required:
```csv
username,status,category,price
@rose,available,Short Names,
@gram,current offer,Brand Names,
@flowers,sold,Word Names,
```
Accepted status aliases: `available`, `current offer`, `current_offer`, `offer`, `sold`.
Categories are created dynamically from CSV values. Price is optional; leave the price column blank until you want to set it. If entered, it must be a non-negative number. Usernames are normalized case-insensitively for uniqueness; a leading `@` is optional and is normalized away in the key but preserved in display as `@name`.

## Import behavior
- Preview/validation happens in the browser first.
- Each valid row is submitted to a callable function.
- Existing usernames are skipped; they are never overwritten by CSV import.
- Import requests are chunked into groups of 100.
- A result reports added, skipped and invalid counts.
- Import is not a single all-or-nothing transaction across the whole CSV. If a network failure occurs midway, re-uploading is safe because duplicates are skipped.

## Data model
`inventory/{normalizedUsernameKey}`:
- `username`: string
- `status`: `available` | `current offer` | `sold`
- `category`: string
- `price`: number (USD)
- `archived`: boolean
- `createdAt`, `updatedAt`: timestamps
- `createdBy`, `updatedBy`: admin UID

`auditLogs/{autoId}` contains operation, affected username, admin UID and timestamp.

## Security checklist before launch
- Use a strong password and enable MFA for the admin email account where available.
- Keep only trusted accounts with the admin custom claim.
- Do not expose service account credentials.
- Set a billing budget alert and review Cloud Functions/Firestore costs.
- Test rules with the Firebase Emulator Suite.
- Do not treat the public inventory as confidential: active usernames/prices are intentionally public.
