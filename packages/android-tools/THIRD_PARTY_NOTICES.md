# Third-party notices

`@iyexin/mio-android-tools` itself is part of Mio.

When Mio distributes an Android tools bundle, include the upstream notices:

- **Android SDK build-tools** (`apksigner.jar`, `zipalign`): Apache License 2.0,
  Copyright (C) The Android Open Source Project. Include the build-tools `NOTICE.txt`.
- **Eclipse Temurin / OpenJDK runtime**: GPLv2 with the Classpath Exception. Include the
  upstream `legal/` directory and license files from the JRE distribution.
- **undici**: MIT License.
- **tar**: ISC License.
- **node-forge** (only if a third-party signer is used; not part of the current signing path):
  BSD-3-Clause.

The bundle builder should copy the relevant `NOTICE`/`LICENSE` files into the archive at
release time. This file is a checklist, not a replacement for the upstream license texts.
