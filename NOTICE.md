# Licensing notice for the Lyrics Karaoke plugin

Everything in this plugin except the file listed below keeps the plugin's existing terms. That includes
`screen.js`, every file in `src/` other than `src/yarg-overdrive.js`, `screen.html`, `settings.html`,
`routes.py`, `plugin.json`, the assets, `tools/` and the tests.

One file carries overdrive (star power) numbers from [YARG.Core](https://github.com/YARC-Official/YARG.Core)
and [YARG](https://github.com/YARC-Official/YARG) and is licensed under the
**GNU Lesser General Public License v3.0** (full text in [`LICENSE.LGPL-3.0`](LICENSE.LGPL-3.0); the LGPL
builds on the GNU GPL v3.0, whose text is in [`LICENSE.GPL-3.0`](LICENSE.GPL-3.0)):

| File | Status |
|------|--------|
| `src/yarg-overdrive.js` | LGPL-3.0. JavaScript re-implementation, with modifications, of YARG's star power numbers: a quarter bar per phrase (`GainStarPower`/`AwardStarPower`), half a bar to activate (`ActivateStarPower`), a full bar lasting 8 measures and the doubled multiplier from YARG.Core's `YARG.Core/Engine/BaseEngine*.cs`, and the 25 dB frame-to-frame mic rise YARG's vocals use as an onset. Copyright (c) YARC (YARG) contributors. |

`src/yarg-overdrive.js` is a standalone, unminified ES module with no dependencies, shipped as its own file.
The rest of the plugin (for example `src/overdrive.js` and `src/mic-hit.js`) only uses it through its
exports, so it remains a separate work that uses the Library as described in LGPL-3.0 section 4
("Combined Works"). You may replace `src/yarg-overdrive.js` with a modified version. If you distribute
changes to `src/yarg-overdrive.js`, they must stay under LGPL-3.0 and their source must stay available.
LGPL-3.0 is compatible with feedBack's AGPL-3.0.

The header of `src/yarg-overdrive.js` names its sources and modifications. The plugin uses no artwork,
fonts, logos or sounds from YARG or any other rhythm game.
