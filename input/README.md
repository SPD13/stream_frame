# Steam Input layout (pending spike S6)

The plan ships a default Steam Input layout (`stream-frame.vdf`, gamepad mode, Menu → Home)
only if spike [S6](../docs/spikes/S6.md) finds a way to install one for a non-Steam shortcut.
Until then the helper extension works with whatever layout the user picks, because it listens
to both keyboard events and the Gamepad API; see the README's "Controller" section.
