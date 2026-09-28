# Picture quality by service

Measured on the Steam Frame in Stream Frame (Google Chrome for ARM64 Linux, Widevine L3).
**Not measured yet**: this table holds the research expectations from `docs/plan.md` until
spike [S1](spikes/S1.md) replaces them with measurements.

| Service | Expected max | Measured | Notes |
|---|---|---|---|
| Netflix | 720p; 1080p with the New Netflix 1080p extension | | |
| HBO Max | unknown | | blocked Linux in 2020; reports contradictory |
| Hulu | works, cap unconfirmed | | |
| Disney+ | 480p | | reportedly enforced for Linux browsers |
| Apple TV+ | 480p to 720p | | |
| Prime Video | 480p to 540p | | |
| YouTube | full resolution (no DRM) | | movies / YouTube TV use Widevine L3 |
| Crunchyroll | unconfirmed | | |
| Paramount+ | unconfirmed | | |
| Peacock | unconfirmed | | |
| Tubi | unconfirmed | | free, ad-supported |
| Pluto TV | unconfirmed | | free, ad-supported |

4K and HDR are not possible on any DRM service in Linux Chrome.

The panel itself renders at 1280×720 by default (spike [S3](spikes/S3.md)), so anything above 720p
is downscaled unless the panel size can be raised.
