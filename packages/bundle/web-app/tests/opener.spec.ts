import { describe, expect, it } from 'vitest'
import { newWindowLaunch } from '../src/opener.ts'

describe('newWindowLaunch', () => {
  it('opens Brave through AppleScript so the loopback token URL actually loads', () => {
    if (process.platform !== 'darwin') return
    const launch = newWindowLaunch('brave', 'http://127.0.0.1:3080/?token=abc')
    expect(launch?.command).toBe('osascript')
    expect(launch?.args[1]).toContain('tell application "Brave Browser"')
    expect(launch?.args[1]).toContain('make new window')
    expect(launch?.args[1]).toContain('http://127.0.0.1:3080/?token=abc')
  })
})
