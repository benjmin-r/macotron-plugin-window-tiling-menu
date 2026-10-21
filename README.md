# Window Tiling Menu for Macotron

Keyboard window tiling for [Macotron](https://github.com/statico/macotron), in
the style of Moom. Press one shortcut and a menu appears, listing every tiling
action with the key that triggers it. Press that key and the focused window
moves into place. Press Esc, or click away, and nothing happens.

There is a single activation shortcut to remember. Everything else is a single
key you can read off the screen.

- **Special actions** cover the usual placements: the four halves, the four
  corners, Center, Full Screen, thirds, two thirds, and moving a window to the
  next or previous display.
- **Custom grid actions** are drawn rather than typed. Pick a grid size, drag
  across the cells the window should cover, and give the action a name and a
  key.
- **Every action has a name and one key.** You choose both, and the menu shows
  them next to a small picture of where the window will go.
- **The activation shortcut is recorded in Settings**, like any other Macotron
  shortcut.
- The actions can be kept in a JSON file, so they can live in a dotfiles repo.

## Requirements

Macotron with plugin API 1.5 or newer. The plugin says so in its first line
(`// @macotron needs 1.5`) and Macotron will not load it on an older host. It
was written and tested on Macotron 0.9.1.

It needs the Accessibility permission, because moving another app's window is an
accessibility operation. macOS asks the first time a window moves.

## Install

1. Copy [`window-tiling-menu.js`](window-tiling-menu.js) into the `plugins/`
   folder of your Macotron workdir.
2. Open Macotron, go to Settings → Plugins, and make sure **Window Tiling
   Menu** is enabled. A plugin that is new or has changed may need your
   approval there first.
3. Under **Shortcuts**, record a key combination for **Tile Window**. The
   plugin ships with `ctrl+opt+w`.

## Using it

1. Focus the window you want to move.
2. Press the **Tile Window** shortcut. The menu opens.
3. Press the key next to the action you want, or click its row.

Pressing the shortcut again while the menu is open closes it. Focus goes back
to the window you started from if you cancel.

With more than nine actions the menu shows two columns. Keys are matched on
what you type, so holding `ctrl` or `opt` from the shortcut while you press the
action key still works. Esc is always cancel, so it cannot be bound to an
action.

### The default actions

These are what you get until you change something. Every one can be renamed,
rebound, moved, or deleted.

| Key | Action |
|---|---|
| `h` / `l` | Left half / Right half |
| `k` / `j` | Top half / Bottom half |
| `y` / `u` | Top left / Top right |
| `b` / `n` | Bottom left / Bottom right |
| `f` | Full screen |
| `c` | Center |
| `1` / `2` / `3` | First / Center / Last third |
| `4` / `5` | First two thirds / Last two thirds |
| `]` / `[` | Next display / Previous display |

The letters follow vim's movement keys, with `y u b n` for the diagonals.

## Configuring the actions

Open the editor with **Edit** in the menu's header, or run **Configure Tiling
Actions** from the Macotron launcher. Macotron's Settings can only show fixed
kinds of field, so the editor is a window of its own. Changes save as you make
them.

The list on the left is the menu, in order. Pick an action to edit it:

- **Name** is what the menu shows.
- **Key** is recorded: click it, then press the key. A key another action
  already uses is refused, and the message says which one.
- **Placement** is either **Custom grid**, or one of the special actions. Picking
  a special action fills in its name, unless you had already renamed the action.
- For a **custom grid**, set the columns and rows (1 to 20 of each), then drag
  across the cells the window should cover. The selection is remembered, so the
  grid shows it the next time you open the action.

**Add** creates an action on the first unused letter or digit. The arrows move
the selected action up or down the menu. **Reset to defaults** replaces
everything, after asking.

A key is one character, or one of `left`, `right`, `up`, `down`, `space`,
`return`, `tab`.

### Special actions

Left Half, Right Half, Top Half, Bottom Half, Top Left, Top Right, Bottom Left,
Bottom Right, Full Screen, Center, First Third, Center Third, Last Third, First
Two Thirds, Last Two Thirds, Next Display, Previous Display.

Center is 75% of the screen in each direction. Next and Previous Display move
the window to the neighbouring display, full screen, and wrap round after the
last one. They do nothing on a Mac with a single display.

### Keeping the actions in a file

By default the actions are kept in Macotron's local storage. To put them under
version control, set **Actions file** in the plugin's settings to a path such as
`~/.config/macotron/tiling-actions.json`.

- The file is created on the first save. Actions already in local storage are
  moved into it.
- It is a JSON array with one action per line, so a diff shows exactly which
  action changed. You can edit it by hand.
- The plugin reads it when it loads. After editing it outside the plugin, or
  pulling a change to it, restart Macotron or save any plugin file to pick it up.
- A file that is not valid JSON is not overwritten when the plugin loads. The
  defaults are used, and the plugin's page in Settings shows a warning. The file
  is replaced the next time you save from the editor.

An action is one of two shapes:

```json
{"key":"h","name":"Left Half","special":"left-half"}
{"key":"1","name":"Left Two Cols","grid":{"cols":6,"rows":6,"c0":0,"r0":0,"c1":1,"r1":5}}
```

`c0`, `r0` and `c1`, `r1` are the first and last cell of the selection, counted
from zero at the top left. Actions the plugin cannot make sense of are dropped
on load, and the reason is shown in Settings and in the log.

## Options

| Option | Default | What it does |
|---|---|---|
| Tile Window (shortcut) | `ctrl+opt+w` | Opens the menu. Recorded under Shortcuts in Settings → Plugins |
| Gap (px) | 0 | Space between a tiled window and the screen edge or its neighbour, 0 to 40 |
| Actions file | empty | A JSON file to keep the actions in. Empty means Macotron's local storage |

## What this does not do

- **No cycling or toggling.** Pressing a key places the window. Pressing it
  again leaves it there. There is no "left half, then right half" cycle and no
  undo to the previous size.
- **Next and Previous Display always go full screen.** They do not keep the
  window's size or position relative to the display.
- **It acts on one window.** That is the window focused when you pressed the
  shortcut. Macotron's own windows are never the target.
- **Placement is a fraction of the window's current display.** A grid selection
  covers the same share of a small display as of a large one, and a window is
  placed on the display it is already on.
- **Apps may not obey.** The window is asked to resize, and an app can clamp,
  refuse or animate the move. Terminals that resize in whole character cells
  will not land exactly on the cells.

## Troubleshooting

Plugin output goes to the system log. Follow it while you reproduce a problem:

```sh
/usr/bin/log stream --level info --style compact \
  --predicate 'subsystem == "io.statico.macotron" AND category == "plugin"'
```

Every line from this plugin starts with `window-tiling-menu:`. It logs when the
menu opens, each placement and its result, each save, and any error reported by
the menu or the editor page. For each page it opens it also logs how many rows
the page contains when its script ends and again after half a second and two
seconds, so a page that renders and then empties shows as a drop to 0 rows. In a
shell where `log` is a builtin, such as zsh, use `/usr/bin/log` as above.

If the menu does not open at all, check that the plugin is enabled and approved,
that Accessibility is granted, and that the plugin's page in Settings has no
warning under Checks.

## Licence

MIT. See [LICENSE](LICENSE).
