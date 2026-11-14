tell application "System Events"
    tell process "Docker"
        set frontmost to true
        click menu bar item "Docker" of menu bar 1
    end tell
end tell
