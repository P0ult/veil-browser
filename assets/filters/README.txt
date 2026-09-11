The filter lists Veil ships with.

None of these are Veil's work. They are the same lists uBlock Origin uses by
default, included here so that a fresh install blocks properly before it has
downloaded anything, and refreshed from the addresses below by
Settings > Ad block > Update.

  easylist.txt      EasyList - the main advertising list
                    https://easylist.to/easylist/easylist.txt
                    Licence: GPLv3 / CC BY-SA 3.0 - https://easylist.to/pages/licence.html

  easyprivacy.txt   EasyPrivacy - tracking and telemetry
                    https://easylist.to/easylist/easyprivacy.txt
                    Licence: GPLv3 / CC BY-SA 3.0

  ubo-filters.txt   uBlock Origin's own additions
  ubo-privacy.txt   uBlock Origin's privacy additions
  ubo-badware.txt   uBlock Origin's badware risks list
                    https://github.com/uBlockOrigin/uAssets
                    Licence: GPLv3

Veil reads them with src/main/filters.js, which implements the network and
cosmetic parts of the Adblock Plus syntax. Rules that need features it does
not implement - $redirect, $removeparam, scriptlet injection, procedural
selectors - are dropped rather than approximated, which is about 1.4% of what
these files contain.
