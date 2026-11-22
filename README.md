# 🍛 Dal Bhat Power

Dal Bhat Power is a crowdsourced map of what a plate of dal bhat costs across Nepal, like fuel-price apps but for lentils and rice. Use it to plot price against elevation and watch how it changes over time.

## Features

- **Map** of towns, each pinned with its median plate price. You can filter by plate (veg, chicken, mutton…), type of place (local bhojanalaya, trekking teahouse, restaurant) and time period.
- **Trends**:
  - Price vs elevation, with a linear fit ("Rs X more per 1,000 m")
  - National monthly median
  - A sortable town table
- **Menu-photo price reports**:
  - Reads the photo's EXIF timestamp and GPS **on the device**, then re-encodes the image to strip all metadata before upload.
  - Falls back to device location or a tap on the map.
  - Snaps the report to the nearest known town.
- **Elevation**: each report's elevation is looked up server-side with the [Open-Meteo elevation API](https://open-meteo.com/en/docs/elevation-api), which needs no key.
- **Dal bhat feed**: meal photos with captions, an optional price and likes. Posts show only the town, not exact coordinates.
- **Google sign-in** to contribute. Browsing is open to everyone.
- **Reputation** that clients can't tamper with (Cloud Functions write it):

  | Action | Points |
  |---|---|
  | Menu photo with prices | +5, plus +1 per extra plate |
  | Feed post | +2 |
  | Someone confirms your price ("I paid this too") | +2 |
  | Like | +1 |
  | Hidden by community flags | −15 |

- **Flagging**: one flag per user per item. Flags are weighted by reputation: ×2 at 30+ reputation and ×3 at 100+. A score of 3 auto-hides the item for moderator review.
- **Moderation**: moderators get a queue in the *Me* tab where they can restore, remove or ban. Moderator rights come from a custom claim.
- **Rate limit**: more than 15 reports or 10 posts in an hour are held for review.

## Installable app and offline mode

The site is a Progressive Web App:
- **Install:** Android/Chrome shows an *Install* button. On iPhone, open the site in Safari, tap Share, then *Add to Home Screen*.
- **📷 Take photo:** phones strip GPS from photos picked on websites. A photo taken in the app records the phone's own GPS fix and the time instead. GPS works with no signal.
- **Offline:**
  - The service worker (`public/sw.js`) caches the app, libraries, map tiles and recent photos.
  - Firestore's offline cache keeps the last-loaded prices viewable.
  - Price submissions made without signal are saved on the phone (IndexedDB) and upload automatically when back online.

## Stack

| Part | Tech |
|---|---|
| Frontend | Plain HTML/CSS/ES modules, no build step. Leaflet + OpenStreetMap, exifr, Firebase JS SDK from CDNs |
| Auth | Firebase Authentication (Google provider) |
| Data | Cloud Firestore (`firestore.rules` enforces the schema) |
| Photos | Cloud Storage for Firebase (`storage.rules`: own folder, JPEG, < 3 MB) |
| Server logic | Cloud Functions v2 (Node 22): reputation, counters, flags, elevation, moderation |
| Hosting | Firebase Hosting |

## Data model

```
users/{uid}            displayName, photoURL, reputation*, banned*, createdAt
reports/{id}           uid, town, townKey, lat, lng, geoSource(exif|device|map),
                       priceNpr, meal, venueType, venueName, refills,
                       photoPath, observedAt, timeSource(exif|upload),
                       status*(visible|hidden|removed), flagScore*, confirmCount*,
                       elevation*, repAwarded*, createdAt
reports/{id}/confirms/{uid}
posts/{id}             uid, photoPath, caption, town, townKey, priceNpr|null,
                       status*, likeCount*, flagScore*, repAwarded*, createdAt
posts/{id}/likes/{uid}
flags/{type__id__uid}  uid, targetType, targetId, reason, note, createdAt
modlog/{id}            written by functions, readable by moderators
```

Fields marked `*` are written only by Cloud Functions.

## Setup

1. **Create a Firebase project** at <https://console.firebase.google.com>. Then:
   - Upgrade to the **Blaze** plan. Cloud Functions need it, and the elevation lookup makes outbound calls. Expected cost at hobby scale is roughly zero.
   - **Authentication → Sign-in method → enable Google.** Add your hosting domain under *Authorized domains*.
   - **Firestore → Create database.** Pick a location near Nepal, e.g. `asia-south1` (Mumbai). This repo is set up for a database named `dalbhatdb`. If yours has a different name, change it in `firebase.json`, `public/config.js` and `functions/.env`.
   - **Storage → Get started.** Use the same location as Firestore and choose production mode. `firebase deploy` replaces the starter rules with `storage.rules`.
2. **Install the CLI and select the project:**
   ```bash
   npm i -g firebase-tools
   firebase login
   firebase use --add            # pick your project; writes .firebaserc
   ```
3. **Configure:**
   ```bash
   cp public/config.example.js public/config.js     # paste your web app config
   cp functions/.env.example functions/.env          # set FUNCTIONS_REGION = your Firestore location
   cd functions && npm install && cd ..
   ```
   `functionsRegion` in `public/config.js` must match `FUNCTIONS_REGION`.
4. **Deploy:**
   ```bash
   firebase deploy
   ```
   Composite indexes can take a few minutes to build after the first deploy.
5. **Make yourself a moderator.** Download a service-account key: *Project settings → Service accounts → Generate new private key*. Don't commit it. Then:
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scripts/set-moderator.js you@gmail.com
   ```
   Sign out and back in to pick up the claim.

### Local development

```bash
# in public/config.js set useEmulators = true
firebase emulators:start
# open http://127.0.0.1:5000
```

## Notes and next steps

- **Photos often arrive without GPS.** Many phones, messaging apps and some browser photo pickers strip location. The form then asks for device location or a tap on the map. HEIC photos are decoded by the browser if it can, and otherwise the user is asked for a JPEG.
- **Aggregation runs in the browser** over the last 24 months of visible reports, up to 5,000. Past that, move town medians into a scheduled function that writes `towns/{key}` summary docs.
- **Abuse hardening** worth adding before a public launch:
  - Firebase **App Check** (reCAPTCHA Enterprise)
  - An outlier check on prices, e.g. auto-hold anything 3× the town median
  - Image moderation, e.g. Cloud Vision SafeSearch on upload
- **Ingredient baseline idea**: pull WFP retail prices for rice and lentils by district from HDX ("Nepal – Food Prices"). Then split each plate price into ingredient cost and "everything else" (porterage, fuel, tourist markup).
- `public/towns.js` holds ~50 seed towns with approximate coordinates. Add more freely, since users can also type any town.
