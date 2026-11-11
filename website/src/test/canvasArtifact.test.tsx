/**
 * A canvas artifact on its detail page: it saves itself after a pause, never
 * over content changed elsewhere, never over a document it cannot read, and a
 * past version only pans and zooms. Plus the library thumbnail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiError } from '../api/apiError'
import type { Artifact } from '../types'
import { emptyCanvas, parseCanvas, serializeCanvas, type Canvas } from '../components/canvas/canvasModel'
import { canvasDocument, discardCanvas, flushCanvas } from '../components/canvas/canvasPending'
import { NavigationLeaveGuardProvider, useMayLeaveForNavigation } from '../components/NavigationLeaveGuard'

const updateArtifact = vi.fn()
const artifact = vi.fn()
const createArtifact = vi.fn()
const setArtifactFolder = vi.fn()
const deleteArtifact = vi.fn()
vi.mock('../api/client', () => ({
  api: {
    updateArtifact: (...a: unknown[]) => updateArtifact(...a),
    artifact: (...a: unknown[]) => artifact(...a),
    createArtifact: (...a: unknown[]) => createArtifact(...a),
    setArtifactFolder: (...a: unknown[]) => setArtifactFolder(...a),
    deleteArtifact: (...a: unknown[]) => deleteArtifact(...a),
  },
}))

const { default: CanvasArtifactBody } = await import('../components/canvas/CanvasArtifactBody')
const { default: CanvasThumb } = await import('../components/canvas/CanvasThumb')
const { default: CustomColor } = await import('../components/canvas/CustomColor')
const { default: CanvasContextMenu } = await import('../components/canvas/CanvasContextMenu')
const { useArtifactsPageCreate } = await import('../pages/useArtifactsPageCreate')
const { default: CanvasPanelView } = await import('../components/canvas/CanvasPanelView')
const { fileTypeForKind } = await import('../components/ArtifactBody')

const withShapes = (n: number): Canvas => ({
  ...emptyCanvas(),
  shapes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind: 'sticky' as const, x: i * 240, y: 0, w: 200, h: 200, text: '', color: 'yellow' as const })),
})

const art = (content: string, extra: Partial<Artifact> = {}): Artifact => ({
  slug: 'board', name: 'Board', kind: 'canvas', content, content_token: 't1', version: 1,
  ...extra,
} as Artifact)

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

/** Drop a sticky with the dock: the one edit every test makes. */
function addSticky() {
  fireEvent.click(screen.getByTestId('tool-sticky'))
  const canvas = screen.getByTestId('canvas-editor')
  act(() => { fireEvent.pointerDown(canvas, { clientX: 400, clientY: 400, button: 0, pointerId: 1 }) })
  act(() => { fireEvent.pointerUp(window, { clientX: 400, clientY: 400, button: 0, pointerId: 1 }) })
  // The new sticky opens for typing; leaving it empty ends the edit.
  act(() => { (screen.getByTestId('canvas-shape-editor') as HTMLTextAreaElement).blur() })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  updateArtifact.mockReset()
  artifact.mockReset()
  createArtifact.mockReset()
  setArtifactFolder.mockReset()
  deleteArtifact.mockReset()
})

describe('a canvas artifact', () => {
  it('saves a pause after the last change, as a live save on the token it read, and chains the next token', async () => {
    updateArtifact.mockResolvedValueOnce({ content_token: 't2' }).mockResolvedValueOnce({ content_token: 't3' })
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(emptyCanvas()))} isCurrent />))
    expect(screen.getByTestId('canvas-save-status').textContent).toBe('Saved')

    addSticky()
    expect(screen.getByTestId('canvas-save-status').textContent).toBe('Unsaved changes')
    expect(updateArtifact).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(updateArtifact).toHaveBeenCalledTimes(1)
    const [slug, body] = updateArtifact.mock.calls[0] as [string, { content: string; snapshot: boolean; expected_token: string }]
    expect(slug).toBe('board')
    expect(body.snapshot).toBe(false)
    expect(body.expected_token).toBe('t1')
    const saved = parseCanvas(body.content)
    expect(saved.ok && saved.canvas.shapes.map(s => s.kind)).toEqual(['sticky'])
    expect(screen.getByTestId('canvas-save-status').textContent).toBe('Saved')

    addSticky()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect((updateArtifact.mock.calls[1][1] as { expected_token: string }).expected_token).toBe('t2')
  })

  it('a canvas changed elsewhere stops saving and asks; keeping mine saves on the live token', async () => {
    updateArtifact.mockRejectedValueOnce(new ApiError(409, 'stale', JSON.stringify({ current_token: 'tX' })))
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(emptyCanvas()))} isCurrent />))
    addSticky()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(screen.getByText('This canvas changed somewhere else')).toBeTruthy()

    // Further edits wait for the person's choice rather than retrying into the same refusal.
    addSticky()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(updateArtifact).toHaveBeenCalledTimes(1)

    artifact.mockResolvedValueOnce({ ...art(serializeCanvas(withShapes(3))), content_token: 'tLive' })
    updateArtifact.mockResolvedValueOnce({ content_token: 'tMine' })
    await act(async () => { fireEvent.click(screen.getByText('Keep my version')); await vi.advanceTimersByTimeAsync(0) })
    expect(updateArtifact).toHaveBeenCalledTimes(2)
    const body = updateArtifact.mock.calls[1][1] as { content: string; expected_token: string }
    expect(body.expected_token).toBe('tLive')
    const mine = parseCanvas(body.content)
    expect(mine.ok && mine.canvas.shapes).toHaveLength(2)
    expect(screen.queryByText('This canvas changed somewhere else')).toBeNull()
  })

  it('reloading after a conflict drops my edits and shows what is stored now', async () => {
    updateArtifact.mockRejectedValueOnce(new ApiError(409, 'stale', '{}'))
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(emptyCanvas()))} isCurrent />))
    addSticky()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    artifact.mockResolvedValueOnce({ ...art(serializeCanvas(withShapes(3))), content_token: 'tLive' })
    await act(async () => { fireEvent.click(screen.getByText('Reload the canvas')); await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getAllByTestId('canvas-shape')).toHaveLength(3)
    expect(updateArtifact).toHaveBeenCalledTimes(1)
  })

  it('a document that is not a canvas is never opened for editing, so nothing is saved over it', async () => {
    render(wrap(<CanvasArtifactBody artifact={art('# notes, not a canvas')} isCurrent />))
    expect(screen.getByText("This canvas can't be opened")).toBeTruthy()
    expect(screen.queryByTestId('canvas-editor')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(updateArtifact).not.toHaveBeenCalled()
  })

  it('a canvas mirroring a file on disk has no token to save against, so it opens read-only and never saves', async () => {
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(withShapes(2)), { content_token: undefined, source_path: '/work/board.kirocanvas' })} isCurrent />))
    expect(screen.getAllByTestId('canvas-shape')).toHaveLength(2)
    expect(screen.queryByTestId('canvas-dock')).toBeNull()
    expect(screen.getByTestId('canvas-readonly-note').textContent).toBe('Linked file: read only')
    act(() => { fireEvent.keyDown(screen.getByTestId('canvas-editor'), { key: 'a', metaKey: true }) })
    act(() => { fireEvent.keyDown(screen.getByTestId('canvas-editor'), { key: 'Backspace' }) })
    expect(screen.getAllByTestId('canvas-shape')).toHaveLength(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(updateArtifact).not.toHaveBeenCalled()
  })

  it('a canvas whose shown text was masked opens read-only, so its placeholders are never saved over the real text', async () => {
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(withShapes(2)), { content_redacted: true })} isCurrent />))
    expect(screen.queryByTestId('canvas-dock')).toBeNull()
    expect(screen.getByTestId('canvas-readonly-note').textContent).toBe('Hidden text: read only')
    act(() => { fireEvent.keyDown(screen.getByTestId('canvas-editor'), { key: 'a', metaKey: true }) })
    act(() => { fireEvent.keyDown(screen.getByTestId('canvas-editor'), { key: 'Backspace' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(updateArtifact).not.toHaveBeenCalled()
  })

  it('reloading into masked text turns the canvas read-only at once, before the page catches up', async () => {
    updateArtifact.mockRejectedValueOnce(new ApiError(409, 'stale', '{}'))
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(emptyCanvas()))} isCurrent />))
    addSticky()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    artifact.mockResolvedValueOnce({ ...art(serializeCanvas(withShapes(3))), content_token: 'tLive', content_redacted: true })
    await act(async () => { fireEvent.click(screen.getByText('Reload the canvas')); await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByTestId('canvas-dock')).toBeNull()
    expect(screen.getByTestId('canvas-readonly-note').textContent).toBe('Hidden text: read only')
  })

  it('a past version pans and zooms but has no tools and never saves', async () => {
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(withShapes(2)))} isCurrent={false} />))
    expect(screen.getAllByTestId('canvas-shape')).toHaveLength(2)
    expect(screen.queryByTestId('canvas-dock')).toBeNull()
    expect(screen.getByTestId('canvas-readonly-note')).toBeTruthy()
    const canvas = screen.getByTestId('canvas-editor')
    act(() => { fireEvent.doubleClick(canvas, { clientX: 400, clientY: 600 }) })
    act(() => { fireEvent.keyDown(canvas, { key: 'Backspace' }) })
    expect(screen.getAllByTestId('canvas-shape')).toHaveLength(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(updateArtifact).not.toHaveBeenCalled()
  })
})

describe('a canvas never loses or overwrites work', () => {
  it('coming back to Live from an identical past version saves on the live token', async () => {
    const body = serializeCanvas(withShapes(1))
    updateArtifact.mockResolvedValueOnce({ content_token: 't2' })
    // Mounted on the past version first: a versioned read carries no token.
    const { rerender } = render(wrap(<CanvasArtifactBody artifact={art(body, { content_token: undefined })} isCurrent={false} />))
    rerender(wrap(<CanvasArtifactBody artifact={art(body, { content_token: 'tLive' })} isCurrent />))
    addSticky()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect((updateArtifact.mock.calls[0][1] as { expected_token?: string }).expected_token).toBe('tLive')
  })

  it('a flush sends a waiting edit at once, so a snapshot taken next holds it', async () => {
    updateArtifact.mockResolvedValueOnce({ content_token: 't2' })
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(emptyCanvas()))} isCurrent />))
    addSticky()
    let saved: boolean | undefined
    await act(async () => { saved = await flushCanvas('board') })
    expect(saved).toBe(true)
    expect(updateArtifact).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('canvas-save-status').textContent).toBe('Saved')
  })

  it('a flush after a failed save tries again, and says when it still cannot save', async () => {
    updateArtifact.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(emptyCanvas()))} isCurrent />))
    addSticky()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    let saved: boolean | undefined
    await act(async () => { saved = await flushCanvas('board') })
    expect(saved).toBe(false)
    expect(updateArtifact).toHaveBeenCalledTimes(2)

    updateArtifact.mockResolvedValueOnce({ content_token: 't2' })
    await act(async () => { saved = await flushCanvas('board') })
    expect(saved).toBe(true)
  })

  it('leaving with edits a failed save left behind asks first, and discarding shows the stored canvas', async () => {
    updateArtifact.mockRejectedValueOnce(new Error('offline'))
    let mayLeave: () => boolean = () => true
    function Probe() { mayLeave = useMayLeaveForNavigation(); return null }
    render(wrap(
      <NavigationLeaveGuardProvider>
        <CanvasArtifactBody artifact={art(serializeCanvas(emptyCanvas()))} isCurrent />
        <Probe />
      </NavigationLeaveGuardProvider>,
    ))
    addSticky()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    let answer: boolean | undefined
    act(() => { answer = mayLeave() })
    expect(answer).toBe(false)
    expect(screen.getByText('Discard unsaved changes?')).toBeTruthy()

    act(() => { discardCanvas('board') })
    expect(screen.queryAllByTestId('canvas-shape')).toHaveLength(0)
    act(() => { answer = mayLeave() })
    expect(answer).toBe(true)
  })

  it('undo after the canvas changed elsewhere cannot write the old canvas back', async () => {
    updateArtifact.mockResolvedValueOnce({ content_token: 't2' })
    const { rerender } = render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(emptyCanvas()))} isCurrent />))
    addSticky()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(updateArtifact).toHaveBeenCalledTimes(1)

    // Another tab adds shapes; the refetch brings them in.
    rerender(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(withShapes(3)), { content_token: 't3' })} isCurrent />))
    expect(screen.getAllByTestId('canvas-shape')).toHaveLength(3)
    const canvas = screen.getByTestId('canvas-editor')
    act(() => { fireEvent.keyDown(canvas, { key: 'z', metaKey: true, ctrlKey: true }) })
    expect(screen.getAllByTestId('canvas-shape')).toHaveLength(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(updateArtifact).toHaveBeenCalledTimes(1)
  })

  it('a text edit left open while the canvas changes elsewhere cannot write the old canvas back', async () => {
    const { rerender } = render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(withShapes(1)))} isCurrent />))
    const canvas = screen.getByTestId('canvas-editor')
    // The one sticky, selected and opened for typing.
    act(() => { fireEvent.keyDown(canvas, { key: 'a', metaKey: true }) })
    act(() => { fireEvent.keyDown(canvas, { key: 'Enter' }) })
    expect(screen.getByTestId('canvas-shape-editor')).toBeTruthy()

    // Another tab adds shapes while the sticky's editor is still open, untouched.
    rerender(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(withShapes(3)), { content_token: 't3' })} isCurrent />))
    const open = screen.queryByTestId('canvas-shape-editor') as HTMLTextAreaElement | null
    if (open) act(() => { open.blur() })
    act(() => { fireEvent.keyDown(canvas, { key: 'z', metaKey: true }) })
    expect(screen.getAllByTestId('canvas-shape')).toHaveLength(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(updateArtifact).not.toHaveBeenCalled()
  })

  it('leaving right after an edit holds the exit until the save lands', async () => {
    let resolveSave: (v: unknown) => void = () => undefined
    updateArtifact.mockReturnValueOnce(new Promise(r => { resolveSave = r }))
    let mayLeave: () => boolean = () => true
    function Probe() { mayLeave = useMayLeaveForNavigation(); return null }
    render(wrap(
      <NavigationLeaveGuardProvider>
        <CanvasArtifactBody artifact={art(serializeCanvas(emptyCanvas()))} isCurrent />
        <Probe />
      </NavigationLeaveGuardProvider>,
    ))
    addSticky()
    let answer: boolean | undefined
    // Before the debounce: the exit is held and the save goes out now, while the page is still here.
    act(() => { answer = mayLeave() })
    expect(answer).toBe(false)
    expect(updateArtifact).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull()
    await act(async () => { resolveSave({ content_token: 't2' }); await vi.advanceTimersByTimeAsync(0) })
    act(() => { answer = mayLeave() })
    expect(answer).toBe(true)
  })

  it('a download reads what the canvas shows, before its autosave has run', () => {
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(emptyCanvas()))} isCurrent />))
    addSticky()
    const shown = parseCanvas(canvasDocument('board') ?? '')
    expect(shown.ok && shown.canvas.shapes).toHaveLength(1)
    expect(updateArtifact).not.toHaveBeenCalled()
  })

  it('a past version has no live document to export, so its stored snapshot is used', () => {
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(withShapes(2)))} isCurrent={false} />))
    expect(canvasDocument('board')).toBeNull()
  })

  it('an unreadable canvas offers to hand the problem to the agent', () => {
    render(wrap(<CanvasArtifactBody artifact={art('# notes, not a canvas')} isCurrent />))
    expect(screen.getByText('Ask the agent')).toBeTruthy()
  })
})

describe('the canvas on a phone', () => {
  it('owns finger drags, keeps the dock inside the canvas, and moves zoom off the dock row', () => {
    render(wrap(<CanvasArtifactBody artifact={art(serializeCanvas(emptyCanvas()))} isCurrent />))
    expect(screen.getByTestId('canvas-editor').style.touchAction).toBe('none')
    const dock = screen.getByTestId('canvas-dock').className
    expect(dock).toContain('max-w-[calc(100%-1.5rem)]')
    expect(dock).toContain('overflow-x-auto')
    // Top right below md, bottom right from md: never on the dock's row on a phone.
    const zoom = screen.getByTestId('canvas-zoom').className.split(' ')
    expect(zoom).toContain('top-3')
    expect(zoom).toContain('md:bottom-5')
  })
})

describe('the custom colour field', () => {
  it('focusing the hex field and leaving it untouched recolours nothing', () => {
    const onHex = vi.fn()
    // A swatch-coloured shape: no custom hex, so the field shows the start colour.
    render(<CustomColor hex={undefined} start="#3FAAFF" onHex={onHex} />)
    const field = screen.getByLabelText('Hex colour') as HTMLInputElement
    act(() => { field.focus() })
    act(() => { field.blur() })
    expect(onHex).not.toHaveBeenCalled()

    act(() => { field.focus() })
    fireEvent.change(field, { target: { value: '#112233' } })
    act(() => { field.blur() })
    expect(onHex).toHaveBeenLastCalledWith('#112233', true)
  })
})

describe('the custom colour picker', () => {
  /** Give the picker's square and hue bar a real size, as a browser lays them out. */
  const sized = (el: HTMLElement) => {
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    return el
  }

  it('the square and the hue bar show each step live and record the whole drag once, on release', () => {
    const onHex = vi.fn()
    render(<CustomColor hex="#FF0000" start="#FF0000" onHex={onHex} />)
    const square = sized(screen.getByTestId('custom-square'))
    fireEvent.pointerDown(square, { clientX: 100, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(square, { clientX: 50, clientY: 50, buttons: 1, pointerId: 1 })
    // A move with no button held is a hover, not part of the drag.
    fireEvent.pointerMove(square, { clientX: 0, clientY: 0, buttons: 0, pointerId: 1 })
    fireEvent.pointerUp(square, { clientX: 50, clientY: 50, pointerId: 1 })
    expect(onHex.mock.calls.map(c => c[1])).toEqual([false, false, true])
    expect(onHex).toHaveBeenLastCalledWith('#804040', true)

    const hue = sized(screen.getByTestId('custom-hue'))
    fireEvent.pointerDown(hue, { clientX: 50, clientY: 5, pointerId: 2 })
    fireEvent.pointerUp(hue, { clientX: 50, clientY: 5, pointerId: 2 })
    expect(onHex).toHaveBeenLastCalledWith('#408080', true)
  })

  it('Enter in the hex field commits what was typed, and text that is not a colour falls back on leaving', () => {
    const onHex = vi.fn()
    render(<CustomColor hex="#FF0000" start="#FF0000" onHex={onHex} />)
    const field = screen.getByLabelText('Hex colour') as HTMLInputElement
    act(() => { field.focus() })
    fireEvent.change(field, { target: { value: '#00F' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onHex).toHaveBeenLastCalledWith('#0000FF', true)

    onHex.mockReset()
    act(() => { field.focus() })
    fireEvent.change(field, { target: { value: 'not a colour' } })
    expect(onHex).not.toHaveBeenCalled()
    act(() => { field.blur() })
    expect(field.value).toBe('#0000FF')
    expect(onHex).not.toHaveBeenCalled()
  })

  it('the eyedropper, where the browser has one, picks a colour from the screen as one step', async () => {
    const open = vi.fn().mockResolvedValue({ sRGBHex: '#123456' })
    vi.stubGlobal('EyeDropper', class { open = open })
    try {
      const onHex = vi.fn()
      render(<CustomColor hex="#FF0000" start="#FF0000" onHex={onHex} />)
      await act(async () => { fireEvent.click(screen.getByLabelText('Pick a colour from the screen')); await Promise.resolve() })
      expect(onHex).toHaveBeenLastCalledWith('#123456', true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the canvas right-click menu', () => {
  it('arrow keys move between the items it offers, Escape closes it, and an item runs then closes', () => {
    const onAction = vi.fn()
    const onClose = vi.fn()
    render(<CanvasContextMenu x={10} y={10} bounds={{ w: 800, h: 800 }} hasSelection={false} canPaste anyLocked={false} onAction={onAction} onClose={onClose} />)
    const menu = screen.getByTestId('canvas-context-menu')
    const enabled = within(menu).getAllByRole('menuitem').filter(b => !(b as HTMLButtonElement).disabled)
    // With nothing selected only paste is offered; locked shapes are what unlock-all needs.
    expect(enabled.map(b => b.textContent)).toEqual([expect.stringContaining('Paste')])
    act(() => { enabled[0].focus() })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(enabled[0])
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(enabled[0])
    fireEvent.keyDown(menu, { key: 'Tab' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(enabled[0])
    expect(onAction).toHaveBeenCalledWith('paste')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('with a selection every item steps in order, wrapping at the ends', () => {
    render(<CanvasContextMenu x={10} y={10} bounds={{ w: 800, h: 800 }} hasSelection canPaste={false} anyLocked onAction={vi.fn()} onClose={vi.fn()} />)
    const menu = screen.getByTestId('canvas-context-menu')
    const enabled = within(menu).getAllByRole('menuitem').filter(b => !(b as HTMLButtonElement).disabled)
    act(() => { enabled[0].focus() })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(enabled[1])
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(enabled[enabled.length - 1])
  })
})

describe('New canvas on the Artifacts page', () => {
  const hook = (scope: { view: 'grid' | 'table'; filtersActive: boolean; scopeFolderId: string }) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const navigate = vi.fn()
    const invalidateFolders = vi.fn()
    const view = renderHook(() => useArtifactsPageCreate({ qc, navigate, invalidateFolders, ...scope }), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    return { ...view, navigate, invalidateFolders }
  }

  it('stores an empty canvas with its kind named, files it in the folder being browsed, and opens it', async () => {
    createArtifact.mockResolvedValueOnce({ slug: 'untitled-canvas', name: 'Untitled canvas' })
    setArtifactFolder.mockResolvedValueOnce({})
    const { result, navigate } = hook({ view: 'grid', filtersActive: false, scopeFolderId: 'f1' })
    await act(async () => { result.current.handleNewCanvas(); await vi.runAllTimersAsync() })
    const body = createArtifact.mock.calls[0][0] as { kind: string; content: string }
    expect(body.kind).toBe('canvas')
    expect(parseCanvas(body.content)).toEqual({ ok: true, canvas: emptyCanvas() })
    expect(setArtifactFolder).toHaveBeenCalledWith('untitled-canvas', 'f1')
    expect(navigate).toHaveBeenCalledWith('/artifacts/untitled-canvas')
    expect(result.current.addError).toBeNull()
  })

  it('a canvas that could not be filed stays on the library, so the note saying it landed at the top is read', async () => {
    createArtifact.mockResolvedValueOnce({ slug: 'untitled-canvas', name: 'Untitled canvas' })
    setArtifactFolder.mockRejectedValueOnce(new Error('gone'))
    const { result, navigate } = hook({ view: 'grid', filtersActive: false, scopeFolderId: 'stale' })
    await act(async () => { result.current.handleNewCanvas(); await vi.runAllTimersAsync() })
    expect(navigate).not.toHaveBeenCalled()
    expect(result.current.addError).toBeTruthy()
  })

  it('a filtered or table view files nothing, since no folder is being browsed', async () => {
    createArtifact.mockResolvedValueOnce({ slug: 'untitled-canvas', name: 'Untitled canvas' })
    const { result } = hook({ view: 'table', filtersActive: false, scopeFolderId: 'f1' })
    await act(async () => { result.current.handleNewCanvas(); await vi.runAllTimersAsync() })
    expect(setArtifactFolder).not.toHaveBeenCalled()
  })

  it('New Artifact creates a blank document in the browsed folder and opens it', async () => {
    createArtifact.mockResolvedValueOnce({ slug: 'untitled', name: 'Untitled' })
    setArtifactFolder.mockRejectedValueOnce(new Error('gone'))
    const { result, navigate } = hook({ view: 'grid', filtersActive: false, scopeFolderId: 'f1' })
    await act(async () => { result.current.handleNewArtifact(); await vi.runAllTimersAsync() })
    expect((createArtifact.mock.calls[0][0] as { content: string }).content).toBe('')
    expect(navigate).toHaveBeenCalledWith('/artifacts/untitled')
    expect(result.current.addError).toBeTruthy()
  })

  it('Add Artifact imports a .kirocanvas file as a canvas and opens it, or reports where it could not file it', async () => {
    const doc = serializeCanvas(withShapes(1))
    createArtifact.mockImplementation(async (b: { content: string }) => ({ slug: 'board', name: 'Board', content: b.content }))
    const { result, navigate } = hook({ view: 'grid', filtersActive: false, scopeFolderId: 'f1' })
    // Clicking Add Artifact opens the file picker.
    const picker = document.createElement('input')
    const click = vi.spyOn(picker, 'click')
    ;(result.current.addFileInputRef as { current: HTMLInputElement | null }).current = picker
    act(() => { result.current.handleAddArtifact() })
    expect(click).toHaveBeenCalled()

    setArtifactFolder.mockResolvedValueOnce({})
    const pick = (file: File | undefined) => ({ target: { files: file ? [file] : [], value: 'x' } } as unknown as React.ChangeEvent<HTMLInputElement>)
    await act(async () => { await result.current.handleAddArtifactFile(pick(new File([doc], 'Board.kirocanvas'))); await vi.runAllTimersAsync() })
    expect((createArtifact.mock.calls[0][0] as { kind: string }).kind).toBe('canvas')
    expect(navigate).toHaveBeenCalledWith('/artifacts/board')

    setArtifactFolder.mockRejectedValueOnce(new Error('gone'))
    await act(async () => { await result.current.handleAddArtifactFile(pick(new File([doc], 'Board.kirocanvas'))); await vi.runAllTimersAsync() })
    expect(result.current.addError).toBeTruthy()

    // Nothing picked does nothing; a file of a type it cannot import is a hint, not a failure.
    await act(async () => { await result.current.handleAddArtifactFile(pick(undefined)) })
    await act(async () => { await result.current.handleAddArtifactFile(pick(new File(['x'], 'photo.bmp'))) })
    expect(result.current.pickHint).toBeTruthy()
    createArtifact.mockReset()
  })

  it('an import whose text the store would redact is refused and removed, never left to corrupt itself', async () => {
    // The store hands back different text than it was sent: what a redaction looks like.
    createArtifact.mockResolvedValueOnce({ slug: 'notes', name: 'notes', content: 'value=[REDACTED]' })
    deleteArtifact.mockResolvedValueOnce({})
    const { result, navigate } = hook({ view: 'grid', filtersActive: false, scopeFolderId: '' })
    await act(async () => {
      result.current.addArtifactMut.mutate({ name: 'notes', content: 'value=plain', kind: 'text', folder: '' })
      await vi.runAllTimersAsync()
    })
    expect(deleteArtifact).toHaveBeenCalledWith('notes')
    expect(navigate).not.toHaveBeenCalled()
    expect(result.current.addError).toBeTruthy()
  })
})

describe('a canvas in the chat side panel', () => {
  it('draws the canvas read-only, and a document that is not one offers the agent', () => {
    const { unmount } = render(wrap(<CanvasPanelView content={serializeCanvas(withShapes(2))} heightStyle={{ height: 400 }} />))
    expect(screen.getByTestId('canvas-panel-view')).toBeTruthy()
    expect(screen.getAllByTestId('canvas-shape')).toHaveLength(2)
    expect(screen.queryByTestId('canvas-dock')).toBeNull()
    unmount()
    render(wrap(<CanvasPanelView content="# notes" heightStyle={{ height: 400 }} />))
    expect(screen.getByText('Ask the agent')).toBeTruthy()
  })

  it('anything without the canvas view renders a canvas as JSON, never as prose', () => {
    expect(fileTypeForKind('canvas')).toBe('json')
  })
})

describe('the canvas thumbnail', () => {
  it('draws one mark per shape, and says so when the canvas is empty', () => {
    const { container, unmount } = render(<CanvasThumb content={serializeCanvas(withShapes(3))} />)
    expect(container.querySelectorAll('[data-testid="canvas-thumb-shape"]')).toHaveLength(3)
    unmount()
    render(<CanvasThumb content={serializeCanvas(emptyCanvas())} />)
    expect(screen.getByText('Empty canvas')).toBeTruthy()
  })
})
