# Test fixtures

`test.p12` is a **throwaway** keystore generated for the signing tests
(`packages/android-tools/test/signing.test.ts`). Its alias and password are the
literal `test` / `password`; the certificate is self-signed and expires quickly.

It exists so `signApk` / `apksigner verify` can be exercised without touching a
real release key. Never reuse it for anything that ships.
