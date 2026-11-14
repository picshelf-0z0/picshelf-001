# Privacy Policy for PicShelf

**Effective Date:** October 5, 2026  
**Application Name:** PicShelf (formerly Aura Photo Organizer)  
**Package Name:** `com.aistudio.photoorganizer.xwylza`  
**Developer:** picshelf-0z0  
**GitHub Repository:** [https://github.com/picshelf-0z0/picshelf-001](https://github.com/picshelf-0z0/picshelf-001)  
**Hosted Privacy Policy:** [https://picshelf-0z0.github.io/picshelf-001/privacy-policy.html](https://picshelf-0z0.github.io/picshelf-001/privacy-policy.html)  

---

## 1. Introduction & Our Core Privacy Commitment

Welcome to **PicShelf**. We take your personal privacy seriously and comply fully with Google Play Store policies. Unlike traditional cloud photo platforms, **PicShelf is designed with a strict "Local-First, Zero-Cloud-Tracking" architecture for users aged 18 years and older (18+)**.

- **Zero Personal Data Collection:** We do **not** ask for, collect, transmit, or store your name, email address, phone number, contacts, or personal identity.
- **No Location Tracking:** We do **not** track, collect, or transmit your physical or GPS location to any external server.
- **100% On-Device Storage:** Your personal photos, videos, albums, tags, metadata, and editing history **remain 100% on your own device**. We do not operate external media servers that upload, scan, or analyze your pictures.
- **Permanent Erasure When You Delete the App:** If you uninstall/delete the PicShelf app (or clear its storage), everything stored inside the app is permanently and irreversibly erased.
- **Strictly 18+ Users Only:** This application is intended exclusively for adults aged **18 years and older (18+)**.

---

## 2. Permissions Required & How They Are Used

To provide full photo organization and studio editing functionality, PicShelf requests the following Android system permissions. Each permission is used strictly for local on-device features:

| Permission | Technical Name | Purpose in PicShelf |
| :--- | :--- | :--- |
| **Photos & Media** | `READ_MEDIA_IMAGES` / `READ_EXTERNAL_STORAGE` | Allows the app to index your device's photo gallery, display albums, detect duplicate images, and allow editing and organizing locally on your device. |
| **Media Location** | `ACCESS_MEDIA_LOCATION` | Allows PicShelf to read embedded EXIF GPS tags strictly on-device so you can view photo capture locations on the built-in world map. Location data is never sent off your device. |
| **Camera** | `CAMERA` | Allows you to capture new photos directly into specific albums within PicShelf on your device. |
| **Precise / Coarse Location** | `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | When capturing photos with the in-app camera, this allows embedding GPS coordinates locally into the image EXIF data (can be toggled on/off in Settings). Never transmitted to any server. |
| **In-App Billing** | `com.android.vending.BILLING` | Enables secure Google Play Store purchases for PicShelf Pro subscriptions. |
| **Notifications** | `POST_NOTIFICATIONS` | Displays local background progress indicators for bulk album exports, duplicate scans, and optional Google Play update checks. |

---

## 3. Data Collection, Storage, and Processing

### A. Zero Collection of Personal Data, Email, or Location
- PicShelf does **not** require user registration or login.
- We do **not** collect, transmit, or store your email address, name, phone number, contacts, or device GPS location.
- Any location metadata accessed from photo EXIF tags or optional camera geotagging stays 100% locally on your device and is never sent to us or any third party.

### B. 100% On-Device Photo Processing
- All AI subject extraction, background blurs, optical filters, compression, and duplicate detection algorithms execute **locally on your device**.
- No image data, face hashes, videos, or photo contents are ever transmitted to any external server.

### C. Biometric & App Lock
- If you enable the in-app biometric lock or PIN, authentication is verified locally through Android's hardware security framework (`KeyStore` / `BiometricManager`). We do not store or transmit your fingerprint, face scan, or passcode.

### D. Analytics and Advertising
- PicShelf does **not** integrate third-party ad networks, behavioural tracking SDKs, or data brokers.
- Purchase and subscription analytics used strictly for Google Play billing verification are described below.
- We do **not** sell, rent, share, or monetize your personal data or media.

---

## 4. Payment Information (Google Play In-App Billing)

Financial transactions and subscription management for PicShelf Pro are handled exclusively by **Google Play In-App Billing** (governed by [Google Play's Terms of Service](https://play.google.com/intl/en_us/about/play-terms/)). 
- PicShelf does not collect, receive, or store your email address, credit card, debit card, bank account, UPI details, or billing address.
- All purchases can be managed, canceled, or refunded directly through your Google Play Store account settings.
- PicShelf uses RevenueCat to verify and restore Pro access. Its SDK sends Google Play purchase tokens, purchase and subscription information, an anonymous app user identifier, and necessary app/device technical information to RevenueCat over HTTPS. RevenueCat retains purchase and entitlement records for subscription management and purchase analytics. Your photos, videos, audio, email, location, and album organization are not sent to RevenueCat. Clearing local app data does not delete purchase records held by Google Play or RevenueCat. See [RevenueCat's Privacy Policy](https://www.revenuecat.com/privacy).

---

## 5. User Rights & Permanent Data Erasure on Uninstall

Because all your photos, in-app albums, tags, notes, presets, and app settings exist solely on your local device with zero cloud backup:
- **Deleting Items in the App**: Deleting photos, videos, or albums inside PicShelf removes them from the app's local database.
- **Permanent Data Erasure When You Delete / Uninstall the App**: **If you uninstall (delete) the PicShelf application from your device—or clear its data by going to Settings > Apps > PicShelf > Storage > Clear Data—everything stored inside the app (including all in-app albums, vault items, tags, edits, presets, and local databases) will be permanently and irreversibly erased.** Because all user data lives strictly on your own device and never on our servers, we cannot recover any deleted app data after uninstallation.

---

## 6. Age Requirement & Children's Privacy (18+ Users Only)

**PicShelf is intended strictly for users aged 18 years and older (18+).**
- This application is designed for adults (18+) and is **not** directed at, marketed to, or intended for children or anyone under 18 years of age (including children under the age of 13 under COPPA).
- If you are under 18 years old, please do not install or use PicShelf.
- We do not knowingly collect, solicit, or store personal data, email addresses, or location data from anyone of any age, including anyone under 18.

---

## 7. Changes to This Privacy Policy

We may update our Privacy Policy periodically. Any updates will be published directly to this repository and within the application's settings menu.

---

## 8. Contact Us

If you have questions, feedback, or concerns regarding this Privacy Policy, please contact us:
- **GitHub Issues:** [https://github.com/picshelf-0z0/picshelf-001/issues](https://github.com/picshelf-0z0/picshelf-001/issues)
- **Repository:** [https://github.com/picshelf-0z0/picshelf-001](https://github.com/picshelf-0z0/picshelf-001)
