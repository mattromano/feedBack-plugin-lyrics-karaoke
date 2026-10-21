/*
 * yarg-overdrive.js: vocal overdrive (star power) numbers from YARG for the feedBack Lyrics Karaoke plugin.
 *
 * Re-implemented from the numbers and rules in:
 *   YARG.Core (https://github.com/YARC-Official/YARG.Core):
 *     YARG.Core/Engine/BaseEngine.cs and BaseEngine.Generic.cs (GainStarPower and AwardStarPower: a
 *     completed star power phrase awards a quarter bar; ActivateStarPower: activation needs half a bar;
 *     STAR_POWER_MAX_MEASURES: a full bar lasts 8 measures and drains while active; the score
 *     multiplier doubles while star power is active)
 *     the vocals engine's star power activation and vocal percussion onset: a frame-to-frame rise in the
 *     mic level of at least 25 dB
 *   YARG (https://github.com/YARC-Official/YARG, also LGPL-3.0)
 *
 * Copyright (c) YARC (YARG) contributors
 * Licensed under the GNU Lesser General Public License v3.0
 * (see https://github.com/YARC-Official/YARG.Core/blob/master/LICENSE, and LICENSE.LGPL-3.0 at the plugin
 * root; LGPL-3.0 builds on the GPL-3.0 in LICENSE.GPL-3.0).
 *
 * Written in JavaScript for the feedBack Lyrics Karaoke plugin. This file is a derivative work of the
 * above files and stays under LGPL-3.0. The rest of the plugin keeps its own terms (see NOTICE.md) and
 * only uses this file through its exports.
 * Modifications: a dependency-free ES module holding plain numbers. The bar is a fraction (0..1) of a full
 * bar, drained by fractional measures rather than chart ticks; the meter itself lives in src/overdrive.js
 * and the mic-hit detector in src/mic-hit.js.
 */

// phraseGain: a quarter bar per earned phrase. deployMin: half a bar to activate.
// barMeasures: a full bar lasts 8 measures. multiplier: points double while active.
export const OVERDRIVE = Object.freeze({ phraseGain: 0.25, deployMin: 0.5, barMeasures: 8, multiplier: 2 });

// The mic-level rise between two frames, in dB, that counts as a clap or shout.
export const MIC_HIT_RISE_DB = 25;
