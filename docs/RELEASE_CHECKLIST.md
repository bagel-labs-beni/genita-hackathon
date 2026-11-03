# Genita release checklist

After the iOS build is valid in TestFlight and the signed Mac DMG has been published, update the
server `GENITA_APP_CONFIG_FILE` with the exact released build values. Keep `minBuild` unchanged
unless an update must be mandatory, then verify `GET /v1/app-config` after its cache window.

```json
{"updates":{"ios":{"latestBuild":<TestFlight CFBundleVersion>},"mac":{"latestBuild":<DMG build>}}}
```
