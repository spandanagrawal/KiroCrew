/**
 * Task Runner keeps its pop-out window after it stopped being the built-in app
 * `projects`: the rail's pop-out action and the pop-out frame both judge a route
 * with `hasPopoutPage`.
 */
import { describe, it, expect } from 'vitest'
import { corePopoutPage, hasPopoutPage } from './corePopoutPages'
import { hasBuiltinComponent } from '../apps/builtinRegistry'
import { appRouteOf } from '../utils/appPopoutRoute'

describe('core pop-out pages', () => {
  it('Task Runner is a core page, no longer a built-in app route, and still pops out', () => {
    expect(hasBuiltinComponent('/projects')).toBe(false)
    expect(hasPopoutPage('/projects')).toBe(true)
    expect(corePopoutPage('/projects')?.labelKey).toBe('nav.task_runner')
  })

  it('a sub-path stays inside its window, and an unknown route is not a pop-out', () => {
    expect(appRouteOf('/projects/run-1', hasPopoutPage)).toBe('/projects')
    expect(appRouteOf('/schedule', hasPopoutPage)).toBeNull()
    expect(hasPopoutPage('/constructor')).toBe(false)
    expect(corePopoutPage('/toString')).toBeUndefined()
  })

  it('a built-in app route still pops out', () => {
    expect(hasPopoutPage('/md-notebook')).toBe(true)
  })
})
