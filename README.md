# Global Stereo to Mono

An Add On for LUNA by Mitch. It sets the stereo tracks of a session to mono in one click, lets you choose the mono source of each track (L+R, left only or right only), and puts everything back exactly as it was.

## Why work in mono

Mono is where masking is easiest to hear. Masking problems that are not solved in mono have two consequences. First, your mix will not be mono-compatible, and it will translate badly on Bluetooth speakers, soundbars and any system that narrows the stereo image. Second, a mix without masking in mono frees up space, which makes it much easier to spatialize your stereo version.

## Use

1. **GSM finds the stereo tracks of your session by itself**: audio and instrument tracks, in the same order and with the same colours as in LUNA. Tracks unchecked in LUNA's "Tracks" list are left out.
2. **One click converts them all to mono**, with the level compensated (Set all stereo tracks to mono). **One click puts everything back as it was** (Restore all).
3. **Optionally, choose for each track the side that suits your mono mix best** (L+R, L or R, with the switch on its row). Listen from GSM: the S button solos the track alone or with others, following LUNA's LATCH / X-OR mode.

## Tip

Except in special cases, avoid L+R. It often changes the timbre of a track: summing left and right creates comb filtering, which attenuates and boosts some frequencies. Listen to L and R on each track and keep the side that sounds right in mono.

## Technical details

- **Level compensation.** A converted track has both pans centered and its level compensated automatically; with L or R, the other channel is silenced. The compensation goes on the track's Volume Trim, which LUNA does not display. It is applied after the inserts and before the fader, so the level that feeds your inserts and pre-fader sends does not change.
- **Level.** The compensation matches material whose left and right channels are similar. A very wide stereo track can sound a little quieter once centered.
- **Going back.** Nothing is destructive: no audio file or clip is modified, only the pans, the input trims and one level setting of each track. Restore (all tracks, or one track with its STEREO switch) brings back the exact settings the track had before, even if you had customized them. Each action is one undo step. The original values are remembered on this computer, so Restore still works after you close the window or LUNA. Without them (another computer, cleared data, or after updating or reinstalling GSM), Restore returns the pans to 100L / 100R and removes the compensation: click Restore all before you update.
- **Not touched.** Buses, the click and tracks that are already mono. A track whose controls LUNA does not let the Add On use is shown as "unsupported"; L and R are unavailable on a track when LUNA does not let the Add On control its channels separately.
- **Phase.** GSM does not analyze phase and does not correct delays between microphones. It lets you hear the options and choose.
- **Pan law.** GSM takes LUNA's pan law into account, which adds 3 dB to sources panned to the sides.

Requires LUNA 3.1.2 or later.

## Developing

`npm test` runs the tests on LUNA's mock engine. `node node_modules/@uaudio/luna-builder-sdk/sdk/cli.js pack` builds the `.lunaaddon` file.
