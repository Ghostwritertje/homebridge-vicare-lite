# homebridge-vicare-lite

A small Homebridge plugin that puts a Viessmann heat pump (ViCare cloud API) in Apple Home:

| Accessory | HomeKit service | ViCare feature |
|---|---|---|
| Hot water | TemperatureSensor | `heating.dhw.sensors.temperature.hotWaterStorage` |
| Room temperature | TemperatureSensor | `heating.circuits.0.sensors.temperature.room` |
| Outside temperature | TemperatureSensor | `heating.sensors.temperature.outside` |
| Hot water boost | Switch | `heating.dhw.oneTimeCharge` (`activate` / `deactivate`) |

Tested with a Vitocal 111-S (`CU401B_S_64`) behind a Vitoconnect OPTO2, Homebridge 2.5 and Node 26.

## Why not homebridge-vicare?

[homebridge-vicare](https://github.com/vrkttr/homebridge-vicare) only reads temperatures. It can't send commands,
so there's no one-time charge, and every HomeKit read is a cloud call. The free Basic API plan allows only
**1450 calls per 24 h**, and going over that blocks the API for a day.

This plugin fetches all features in **one call every 5 minutes** (about 290 calls a day) and answers HomeKit from
that cache. Fresh values are pushed to Home when they arrive. If the data is older than 3 poll intervals, Home shows
"No Response". After a 429 (rate limit) the plugin waits until the reset time.

## Setup

1. Create a client in the [Viessmann developer portal](https://app.developer.viessmann-climatesolutions.com/):
   - Basic plan, public client (PKCE), reCAPTCHA off
   - redirect URI `http://<homebridge-host-ip>:4200/`
2. Log in once on the Homebridge host:
   ```sh
   printf '%s\n' '<client id>' > ~/.homebridge/vicare-client-id
   VICARE_REDIRECT_URI=http://<homebridge-host-ip>:4200/ node scripts/vicare-auth.mjs   # open the printed URL
   node scripts/vicare-auth.mjs --features   # optional: list what your device offers
   ```
   The refresh token goes to `~/.homebridge/persist/vicare-token.json` (mode 0600) and is never printed. If
   Viessmann sends a rotated refresh token, the plugin saves it there.
3. Add the platform, preferably as a child bridge:
   ```json
   {
     "platform": "ViCareLite",
     "name": "ViCare",
     "clientId": "<client id>",
     "pollInterval": 300,
     "names": { "dhw": "Warm water", "room": "Kamertemperatuur", "outside": "Buitentemperatuur", "boost": "Warm water boost" },
     "_bridge": { "username": "0E:..", "port": 51554 }
   }
   ```

If the token refresh fails (the log says `token refresh failed … run scripts/vicare-auth.mjs again`), run step 2 again.

## Development

`npm install && npm run lint && npm run build`. Release: bump `version`, `npm pack`, tag `vX.Y.Z`, and attach the
`.tgz` to a GitHub release. Install with `npm install -g <tgz or release URL>`.

## License

MIT
