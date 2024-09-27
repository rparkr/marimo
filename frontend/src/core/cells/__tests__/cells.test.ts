/* Copyright 2024 Marimo. All rights reserved. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type NotebookState,
  exportedForTesting,
  flattenTopLevelNotebookCells,
} from "../cells";
import { notebookCells } from "../utils";
import { CellId } from "@/core/cells/ids";
import type { OutputMessage } from "@/core/kernel/messages";
import type { Seconds } from "@/utils/time";
import { EditorView } from "@codemirror/view";
import { python } from "@codemirror/lang-python";
import { EditorState } from "@codemirror/state";
import type { CellHandle } from "@/components/editor/Cell";
import { foldAllBulk, unfoldAllBulk } from "@/core/codemirror/editing/commands";
import type { MovementCallbacks } from "@/core/codemirror/cells/extensions";
import { adaptiveLanguageConfiguration } from "@/core/codemirror/language/extension";
import { OverridingHotkeyProvider } from "@/core/hotkeys/hotkeys";
import {
  focusAndScrollCellIntoView,
  scrollToTop,
  scrollToBottom,
} from "../scrollCellIntoView";
import { CollapsibleTree } from "@/utils/id-tree";

vi.mock("@/core/codemirror/editing/commands", () => ({
  foldAllBulk: vi.fn(),
  unfoldAllBulk: vi.fn(),
}));
vi.mock("../scrollCellIntoView", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(actual as any),
    scrollToTop: vi.fn(),
    scrollToBottom: vi.fn(),
    focusAndScrollCellIntoView: vi.fn(),
  };
});

const { initialNotebookState, reducer, createActions } = exportedForTesting;

function formatCells(notebook: NotebookState) {
  const cells = notebookCells(notebook);
  return `\n${cells.map((cell) => [`key: ${cell.id}`, `code: '${cell.code}'`].join("\n")).join("\n\n")}`;
}

function createEditor(content: string) {
  const state = EditorState.create({
    doc: content,
    extensions: [
      python(),
      adaptiveLanguageConfiguration({
        completionConfig: {
          activate_on_typing: true,
          copilot: false,
          codeium_api_key: null,
        },
        hotkeys: new OverridingHotkeyProvider({}),
        showPlaceholder: true,
        enableAI: true,
        cellMovementCallbacks: {} as MovementCallbacks,
      }),
    ],
  });

  const view = new EditorView({
    state,
    parent: document.body,
  });

  return view;
}

describe("cell reducer", () => {
  let state: NotebookState;
  let cells: ReturnType<typeof flattenTopLevelNotebookCells>;
  let firstCellId: CellId;

  const actions = createActions((action) => {
    state = reducer(state, action);
    for (const [cellId, handle] of Object.entries(state.cellHandles)) {
      if (!handle.current) {
        const handle: CellHandle = {
          editorView: createEditor(state.cellData[cellId as CellId].code),
          registerRun: vi.fn(),
        };
        state.cellHandles[cellId as CellId] = { current: handle };
      }
    }
    cells = flattenTopLevelNotebookCells(state);
  });

  let i = 0;
  const originalCreate = CellId.create.bind(CellId);

  beforeAll(() => {
    CellId.create = () => {
      return `${i++}` as CellId;
    };
  });

  beforeEach(() => {
    i = 0;

    state = initialNotebookState();
    state.cellIds.columns.push(CollapsibleTree.from([]));
    actions.createNewCell({ cellId: "__end__", before: false });
    firstCellId = state.cellIds.columns[0].atOrThrow(0);
  });

  afterAll(() => {
    CellId.create = originalCreate;
  });

  it("can add a cell after another cell", () => {
    actions.createNewCell({
      cellId: firstCellId,
      before: false,
    });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 0
      code: ''

      key: 1
      code: ''"
    `);
  });

  it("can add a cell to the end with code", () => {
    actions.createNewCell({
      cellId: "__end__",
      code: "import numpy as np",
      before: false,
    });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 0
      code: ''

      key: 1
      code: 'import numpy as np'"
    `);

    // Cell should be added to the end and edited
    expect(cells[1].code).toBe("import numpy as np");
    expect(cells[1].edited).toBe(true);
    expect(cells[1].lastCodeRun).toBe(null);
  });

  it("can add a cell before another cell", () => {
    actions.createNewCell({
      cellId: firstCellId,
      before: true,
    });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 1
      code: ''

      key: 0
      code: ''"
    `);
  });

  it("can delete a cell", () => {
    actions.createNewCell({
      cellId: firstCellId,
      before: false,
    });
    actions.deleteCell({
      cellId: firstCellId,
    });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 1
      code: ''"
    `);

    // undo
    actions.undoDeleteCell();
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 2
      code: ''

      key: 1
      code: ''"
    `);
  });

  it("can update a cell", () => {
    actions.updateCellCode({
      cellId: firstCellId,
      code: "import numpy as np",
      formattingChange: false,
    });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 0
      code: 'import numpy as np'"
    `);
  });

  it("can move a cell", () => {
    actions.createNewCell({
      cellId: firstCellId,
      before: false,
    });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 0
      code: ''

      key: 1
      code: ''"
    `);

    // move first cell to the end
    actions.moveCell({
      cellId: firstCellId,
      before: false,
    });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 1
      code: ''

      key: 0
      code: ''"
    `);

    // move it back
    actions.moveCell({
      cellId: firstCellId,
      before: true,
    });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 0
      code: ''

      key: 1
      code: ''"
    `);
  });

  it("can drag and drop a cell", () => {
    actions.createNewCell({
      cellId: firstCellId,
      before: false,
    });
    actions.createNewCell({
      cellId: "1" as CellId,
      before: false,
    });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 0
      code: ''

      key: 1
      code: ''

      key: 2
      code: ''"
    `);

    // drag first cell to the end
    actions.dropCellOver({
      cellId: firstCellId,
      overCellId: "2" as CellId,
    });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 1
      code: ''

      key: 2
      code: ''

      key: 0
      code: ''"
    `);

    // drag it back to the middle
    actions.dropCellOver({
      cellId: firstCellId,
      overCellId: "2" as CellId,
    });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 1
      code: ''

      key: 0
      code: ''

      key: 2
      code: ''"
    `);
  });

  it("can run cell and receive cell messages", () => {
    // HAPPY PATH
    /////////////////
    // Initial state
    let cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.lastCodeRun).toBe(null);
    expect(cell.edited).toBe(false);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Update code
    actions.updateCellCode({
      cellId: firstCellId,
      code: "import marimo as mo",
      formattingChange: false,
    });
    cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.lastCodeRun).toBe(null);
    expect(cell.edited).toBe(true);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Prepare for run
    actions.prepareForRun({
      cellId: firstCellId,
    });
    cell = cells[0];
    expect(cell.status).toBe("queued");
    expect(cell.lastCodeRun).toBe("import marimo as mo");
    expect(cell.edited).toBe(false);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive queued messages
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "queued",
      stale_inputs: null,
      timestamp: new Date(10).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("queued");
    expect(cell.lastCodeRun).toBe("import marimo as mo");
    expect(cell.edited).toBe(false);
    expect(cell.runElapsedTimeMs).toBe(null);
    expect(cell.runStartTimestamp).toBe(null);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive running messages
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "running",
      stale_inputs: null,
      timestamp: new Date(20).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("running");
    expect(cell.lastCodeRun).toBe("import marimo as mo");
    expect(cell.edited).toBe(false);
    expect(cell.runElapsedTimeMs).toBe(null);
    expect(cell.runStartTimestamp).toBe(20);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Console messages shouldn't transition status
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: {
        channel: "stdout",
        mimetype: "text/plain",
        data: "hello!",
        timestamp: 0,
      },
      status: undefined,
      stale_inputs: null,
      timestamp: new Date(22).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("running");
    expect(cell.edited).toBe(false);
    expect(cell.runElapsedTimeMs).toBe(null);
    expect(cell.runStartTimestamp).toBe(20);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive output messages
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: {
        channel: "output",
        mimetype: "text/plain",
        data: "ok",
        timestamp: 0,
      },
      console: {
        channel: "stdout",
        mimetype: "text/plain",
        data: "hello!",
        timestamp: 0,
      },
      status: "idle",
      stale_inputs: null,
      timestamp: new Date(33).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.edited).toBe(false);
    expect(cell.runElapsedTimeMs).toBe(13_000);
    expect(cell.runStartTimestamp).toBe(null);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // EDITING BACK AND FORTH
    /////////////////
    // Update code again
    actions.updateCellCode({
      cellId: firstCellId,
      code: "import marimo as mo\nimport numpy",
      formattingChange: false,
    });
    cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.edited).toBe(true);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Update code should be unedited
    actions.updateCellCode({
      cellId: firstCellId,
      code: "import marimo as mo",
      formattingChange: false,
    });
    cell = cells[0];
    expect(cell.edited).toBe(false);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Update code should be edited again
    actions.updateCellCode({
      cellId: firstCellId,
      code: "import marimo as mo\nimport numpy",
      formattingChange: false,
    });
    cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.lastCodeRun).toBe("import marimo as mo");
    expect(cell.edited).toBe(true);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // ERROR RESPONSE
    /////////////////
    // Prepare for run
    actions.prepareForRun({
      cellId: firstCellId,
    });
    cell = cells[0];
    expect(cell.output).not.toBe(null); // keep old output
    // Queue
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "queued",
      stale_inputs: null,
      timestamp: new Date(40).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.output).not.toBe(null); // keep old output
    // Running
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "running",
      stale_inputs: null,
      timestamp: new Date(50).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.output).not.toBe(null); // keep old output
    // Receive error
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: {
        channel: "marimo-error",
        mimetype: "application/vnd.marimo+error",
        data: [
          { type: "exception", exception_type: "ValueError", msg: "Oh no!" },
        ],
        timestamp: 0,
      },
      console: null,
      status: "idle",
      stale_inputs: null,
      timestamp: new Date(61).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.output).not.toBe(null); // keep old output
    expect(cell.status).toBe("idle");
    expect(cell.lastCodeRun).toBe("import marimo as mo\nimport numpy");
    expect(cell.edited).toBe(false);
    expect(cell.runElapsedTimeMs).toBe(11_000);
    expect(cell.runStartTimestamp).toBe(null);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // INTERRUPT RESPONSE
    /////////////////
    // Prepare for run
    actions.prepareForRun({
      cellId: firstCellId,
    });
    cell = cells[0];
    expect(cell.output).not.toBe(null); // keep old output
    // Queue
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "queued",
      stale_inputs: null,
      timestamp: new Date(40).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.output).not.toBe(null); // keep old output
    // Running
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "running",
      stale_inputs: null,
      timestamp: new Date(50).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.output).not.toBe(null); // keep old output
    // Receive error
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: {
        channel: "marimo-error",
        mimetype: "application/vnd.marimo+error",
        data: [{ type: "interruption" }],
        timestamp: 0,
      },
      console: null,
      status: "idle",
      stale_inputs: null,
      timestamp: new Date(61).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.lastCodeRun).toBe(cell.code);
    expect(cell.edited).toBe(false);
    expect(cell.runElapsedTimeMs).toBe(11_000);
    expect(cell.runStartTimestamp).toBe(null);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all
  });

  it("errors reset status to idle", () => {
    // Initial state
    let cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.lastCodeRun).toBe(null);
    expect(cell.edited).toBe(false);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Update code
    actions.updateCellCode({
      cellId: firstCellId,
      code: "import marimo as mo",
      formattingChange: false,
    });
    cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.lastCodeRun).toBe(null);
    expect(cell.edited).toBe(true);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Prepare for run
    actions.prepareForRun({
      cellId: firstCellId,
    });
    cell = cells[0];
    expect(cell.status).toBe("queued");
    expect(cell.lastCodeRun).toBe("import marimo as mo");
    expect(cell.edited).toBe(false);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // ERROR RESPONSE
    //
    // should reset status to idle
    /////////////////
    // Prepare for run
    actions.prepareForRun({
      cellId: firstCellId,
    });
    cell = cells[0];
    // Receive error
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: {
        channel: "marimo-error",
        mimetype: "application/vnd.marimo+error",
        data: [
          { type: "exception", exception_type: "SyntaxError", msg: "Oh no!" },
        ],
        timestamp: 0,
      },
      console: null,
      stale_inputs: null,
      timestamp: new Date(61).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.lastCodeRun).toBe("import marimo as mo");
    expect(cell.edited).toBe(false);
    expect(cell.runElapsedTimeMs).toBe(null);
    expect(cell.runStartTimestamp).toBe(null);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all
  });

  it("can run a stale cell", () => {
    // Update code of first cell
    actions.updateCellCode({
      cellId: firstCellId,
      code: "import marimo as mo",
      formattingChange: false,
    });
    // Add cell
    actions.createNewCell({
      cellId: firstCellId,
      before: false,
    });
    const secondCell = cells[1].id;
    // Update code
    actions.updateCellCode({
      code: "mo.slider()",
      cellId: secondCell,
      formattingChange: false,
    });

    // Prepare for run
    actions.prepareForRun({
      cellId: secondCell,
    });

    // Receive queued messages
    actions.handleCellMessage({
      cell_id: secondCell,
      output: undefined,
      console: null,
      status: "queued",
      stale_inputs: null,
      timestamp: new Date(10).getTime() as Seconds,
    });
    let cell = cells[1];
    expect(cell.status).toBe("queued");
    expect(cell.lastCodeRun).toBe("mo.slider()");
    expect(cell.edited).toBe(false);
    expect(cell.runElapsedTimeMs).toBe(null);
    expect(cell.runStartTimestamp).toBe(null);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive stale message
    actions.handleCellMessage({
      cell_id: secondCell,
      output: undefined,
      console: null,
      status: undefined,
      stale_inputs: true,
      timestamp: new Date(20).getTime() as Seconds,
    });
    cell = cells[1];
    expect(cell.status).toBe("queued");
    expect(cell.lastCodeRun).toBe("mo.slider()");
    expect(cell.edited).toBe(false);
    expect(cell.runElapsedTimeMs).toBe(null);
    expect(cell.runStartTimestamp).toBe(null);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all
  });

  it("can format code and update cell", () => {
    const firstCellId = cells[0].id;
    actions.updateCellCode({
      cellId: firstCellId,
      code: "import marimo as    mo",
      formattingChange: false,
    });
    let cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.lastCodeRun).toBe(null);
    expect(cell.edited).toBe(true);

    // Run
    actions.prepareForRun({
      cellId: firstCellId,
    });
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: {
        channel: "output",
        mimetype: "text/plain",
        data: "ok",
        timestamp: 0,
      },
      console: {
        channel: "stdout",
        mimetype: "text/plain",
        data: "hello!",
        timestamp: 0,
      },
      status: "idle",
      stale_inputs: null,
      timestamp: new Date(33).getTime() as Seconds,
    });

    // Check steady state
    cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.edited).toBe(false);
    expect(cell.lastCodeRun).toBe("import marimo as    mo");

    // Format code
    actions.updateCellCode({
      cellId: firstCellId,
      code: "import marimo as mo",
      formattingChange: true,
    });
    cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.lastCodeRun).toBe("import marimo as mo");
    expect(cell.edited).toBe(false);
  });

  it("can update a cells config", () => {
    const firstCellId = cells[0].id;
    let cell = cells[0];
    // Starts empty
    expect(cell.config).toEqual({
      disabled: false,
      hide_code: false,
    });

    actions.updateCellConfig({
      cellId: firstCellId,
      config: { disabled: true },
    });
    cell = cells[0];
    expect(cell.config.disabled).toBe(true);

    // Revert
    actions.updateCellConfig({
      cellId: firstCellId,
      config: { disabled: false },
    });
    cell = cells[0];
    expect(cell.config.disabled).toBe(false);
  });

  it("can run a stopped cell", () => {
    // Update code of first cell
    actions.updateCellCode({
      cellId: firstCellId,
      code: "mo.md('This has an ancestor that was stopped')",
      formattingChange: false,
    });

    // Prepare for run
    actions.prepareForRun({
      cellId: firstCellId,
    });

    // Receive queued messages
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "queued",
      stale_inputs: null,
      timestamp: new Date(10).getTime() as Seconds,
    });
    let cell = cells[0];
    expect(cell.status).toBe("queued");
    expect(cell.lastCodeRun).toBe(
      "mo.md('This has an ancestor that was stopped')",
    );
    expect(cell.edited).toBe(false);
    expect(cell.runElapsedTimeMs).toBe(null);
    expect(cell.runStartTimestamp).toBe(null);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive idle message
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "idle",
      stale_inputs: null,
      timestamp: new Date(20).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive stop output
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: {
        channel: "marimo-error",
        mimetype: "application/vnd.marimo+error",
        data: [
          {
            msg: "This cell wasn't run because an ancestor was stopped with `mo.stop`: ",
            raising_cell: "2" as CellId,
            type: "ancestor-stopped",
          },
        ],
        timestamp: new Date(20).getTime() as Seconds,
      },
      console: null,
      status: "idle",
      stale_inputs: null,
      timestamp: new Date(20).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("idle");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((cell.output?.data as any)[0].msg).toBe(
      "This cell wasn't run because an ancestor was stopped with `mo.stop`: ",
    );
    expect(cell.stopped).toBe(true);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive queued message
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "queued",
      stale_inputs: null,
      timestamp: new Date(30).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("queued");
    expect(cell.stopped).toBe(true);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive running message
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "running",
      stale_inputs: null,
      timestamp: new Date(40).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("running");
    expect(cell.stopped).toBe(false);
    expect(cell.output).toBe(null);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all
  });

  it("can initialize stdin", () => {
    const STDOUT: OutputMessage = {
      channel: "stdout",
      mimetype: "text/plain",
      data: "hello!",
      timestamp: 1,
    };
    const STD_IN_1: OutputMessage = {
      channel: "stdin",
      mimetype: "text/plain",
      data: "what is your name?",
      timestamp: 2,
    };
    const STD_IN_2: OutputMessage = {
      channel: "stdin",
      mimetype: "text/plain",
      data: "how old are you?",
      timestamp: 3,
    };

    // Initial state
    let cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.consoleOutputs).toEqual([]);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Prepare for run
    actions.prepareForRun({
      cellId: firstCellId,
    });
    cell = cells[0];
    expect(cell.status).toBe("queued");
    expect(cell.consoleOutputs).toEqual([]);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive queued messages
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "queued",
      stale_inputs: null,
      timestamp: new Date(10).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("queued");
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive running messages
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "running",
      stale_inputs: null,
      timestamp: new Date(20).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("running");
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Add console
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: STDOUT,
      status: undefined,
      stale_inputs: null,
      timestamp: new Date(22).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("running");
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    cell = cells[0];
    expect(cell.consoleOutputs).toEqual([STDOUT]);
    expect(cell.status).toBe("running");
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Ask via stdin
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: STD_IN_1,
      status: undefined,
      stale_inputs: null,
      timestamp: new Date(22).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.consoleOutputs).toEqual([STDOUT, STD_IN_1]);
    expect(cell.status).toBe("running");
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Response to stdin
    actions.setStdinResponse({
      response: "Marimo!",
      cellId: firstCellId,
      outputIndex: 1,
    });
    cell = cells[0];
    expect(cell.consoleOutputs).toEqual([
      STDOUT,
      {
        ...STD_IN_1,
        response: "Marimo!",
      },
    ]);
    expect(cell.status).toBe("running");
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Ask via stdin, again
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: STD_IN_2,
      status: undefined,
      stale_inputs: null,
      timestamp: new Date(22).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.consoleOutputs).toEqual([
      STDOUT,
      { ...STD_IN_1, response: "Marimo!" },
      STD_IN_2,
    ]);
    expect(cell.status).toBe("running");
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Interrupt, so we respond with ""
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: {
        channel: "marimo-error",
        mimetype: "application/vnd.marimo+error",
        data: [{ type: "interruption" }],
        timestamp: 0,
      },
      console: null,
      status: "idle",
      stale_inputs: null,
      timestamp: new Date(61).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.consoleOutputs).toEqual([
      STDOUT,
      { ...STD_IN_1, response: "Marimo!" },
      { ...STD_IN_2, response: "" },
    ]);
  });

  it("can receive console when the cell is idle and will clear when starts again", () => {
    const OLD_STDOUT: OutputMessage = {
      channel: "stdout",
      mimetype: "text/plain",
      data: "hello!",
      timestamp: 1,
    };
    const STDOUT: OutputMessage = {
      channel: "stdin",
      mimetype: "text/plain",
      data: "hello again!",
      timestamp: 2,
    };

    // Initial state
    let cell = cells[0];
    expect(cell.status).toBe("idle");
    expect(cell.consoleOutputs).toEqual([]);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Add console
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: [OLD_STDOUT],
      status: undefined,
      stale_inputs: null,
      timestamp: new Date(1).getTime() as Seconds,
    });

    // Prepare for run
    actions.prepareForRun({
      cellId: firstCellId,
    });
    cell = cells[0];
    expect(cell.status).toBe("queued");
    expect(cell.consoleOutputs).toEqual([OLD_STDOUT]); // Old stays there until it starts running
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive queued messages
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: null,
      status: "queued",
      stale_inputs: null,
      timestamp: new Date(10).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("queued");
    expect(cell.consoleOutputs).toEqual([OLD_STDOUT]); // Old stays there until it starts running
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Receive running messages
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: [], // Backend sends an empty array to clearu
      status: "running",
      stale_inputs: null,
      timestamp: new Date(20).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.status).toBe("running");
    expect(cell.consoleOutputs).toEqual([]);
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all

    // Add console
    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: [STDOUT],
      status: "idle",
      stale_inputs: null,
      timestamp: new Date(22).getTime() as Seconds,
    });
    cell = cells[0];
    expect(cell.consoleOutputs).toEqual([STDOUT]);
    expect(cell.status).toBe("idle");
    expect(cell).toMatchSnapshot(); // snapshot everything as a catch all
  });

  it("can send a cell to the top", () => {
    actions.createNewCell({ cellId: firstCellId, before: false });
    actions.createNewCell({ cellId: "1" as CellId, before: false });
    actions.sendToTop({ cellId: "2" as CellId });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 2
      code: ''

      key: 0
      code: ''

      key: 1
      code: ''"
    `);
  });

  it("can send a cell to the bottom", () => {
    actions.createNewCell({ cellId: firstCellId, before: false });
    actions.createNewCell({ cellId: "1" as CellId, before: false });
    actions.sendToBottom({ cellId: firstCellId });
    expect(formatCells(state)).toMatchInlineSnapshot(`
      "
      key: 1
      code: ''

      key: 2
      code: ''

      key: 0
      code: ''"
    `);
  });

  it("can focus cells", () => {
    actions.createNewCell({ cellId: firstCellId, before: false });
    actions.createNewCell({ cellId: "1" as CellId, before: false });

    actions.focusCell({ cellId: "1" as CellId, before: true });
    expect(focusAndScrollCellIntoView).toHaveBeenCalledWith(
      expect.objectContaining({
        cellId: "0" as CellId,
      }),
    );

    actions.focusTopCell();
    expect(scrollToTop).toHaveBeenCalled();

    actions.focusBottomCell();
    expect(scrollToBottom).toHaveBeenCalled();
  });

  it("can update cell name", () => {
    actions.updateCellName({ cellId: firstCellId, name: "Test Cell" });
    expect(state.cellData[firstCellId].name).toBe("Test Cell");
  });

  it("can set cell IDs and codes", () => {
    const newIds = ["3", "4", "5"] as CellId[];
    const newCodes = ["code1", "code2", "code3"];

    actions.setCellIds({ cellIds: newIds });
    expect(state.cellIds.columns[0].topLevelIds).toEqual(newIds);

    actions.setCellCodes({ codes: newCodes, ids: newIds });
    newIds.forEach((id, index) => {
      expect(state.cellData[id].code).toBe(newCodes[index]);
    });
  });

  it("can fold and unfold all cells", () => {
    actions.foldAll();
    expect(foldAllBulk).toHaveBeenCalled();

    actions.unfoldAll();
    expect(unfoldAllBulk).toHaveBeenCalled();
  });

  it("can clear logs", () => {
    state.cellLogs = [
      { level: "stderr", message: "log1", timestamp: 0, cellId: firstCellId },
      { level: "stderr", message: "log1", timestamp: 0, cellId: firstCellId },
    ];
    actions.clearLogs();
    expect(state.cellLogs).toEqual([]);
  });

  it("can collapse and expand cells", () => {
    actions.createNewCell({ cellId: firstCellId, before: false });
    actions.createNewCell({
      cellId: "1" as CellId,
      before: false,
      code: "# Header",
    });
    actions.createNewCell({
      cellId: "2" as CellId,
      before: false,
      code: "## Subheader",
    });

    const id = state.cellIds.columns[0].atOrThrow(1);
    state.cellRuntime[id] = {
      ...state.cellRuntime[id],
      outline: {
        items: [{ name: "Header", level: 1, by: { id: "header" } }],
      },
    };
    actions.collapseCell({ cellId: id });
    expect(state.cellIds.columns[0].isCollapsed(id)).toBe(true);

    actions.expandCell({ cellId: id });
    expect(state.cellIds.columns[0].isCollapsed(id)).toBe(false);
  });

  it("can show hidden cells", () => {
    actions.createNewCell({ cellId: firstCellId, before: false });
    actions.createNewCell({ cellId: "1" as CellId, before: false });
    actions.collapseCell({ cellId: firstCellId });

    actions.showCellIfHidden({ cellId: "1" as CellId });
    expect(state.cellIds.columns[0].isCollapsed(firstCellId)).toBe(false);
  });

  it("can split and undo split cells", () => {
    actions.createNewCell({
      cellId: firstCellId,
      before: false,
      code: "line1\nline2",
    });
    const nextCellId = state.cellIds.columns[0].atOrThrow(1);

    const originalCellCount = state.cellIds.columns[0].length;
    // Move cursor to the second line
    const editor = state.cellHandles[nextCellId].current?.editorView;
    if (!editor) {
      throw new Error("Editor not found");
    }
    editor.dispatch({ selection: { anchor: 5, head: 5 } });
    actions.splitCell({ cellId: nextCellId });
    expect(state.cellIds.columns[0].length).toBe(originalCellCount + 1);
    expect(state.cellData[nextCellId].code).toBe("line1");
    expect(state.cellData[state.cellIds.columns[0].atOrThrow(2)].code).toBe(
      "line2",
    );

    actions.undoSplitCell({ cellId: nextCellId, snapshot: "line1\nline2" });
    expect(state.cellIds.columns[0].length).toBe(originalCellCount);
    expect(state.cellData[nextCellId].code).toBe("line1\nline2");
  });

  it("can handle multiple console outputs", () => {
    const STDOUT1: OutputMessage = {
      channel: "stdout",
      mimetype: "text/plain",
      data: "output1",
      timestamp: 1,
    };
    const STDOUT2: OutputMessage = {
      channel: "stdout",
      mimetype: "text/plain",
      data: "output2",
      timestamp: 2,
    };

    actions.handleCellMessage({
      cell_id: firstCellId,
      output: undefined,
      console: [STDOUT1, STDOUT2],
      status: "running",
      stale_inputs: null,
      timestamp: new Date(20).getTime() as Seconds,
    });

    const cell = cells[0];
    expect(cell.consoleOutputs).toEqual([STDOUT1, STDOUT2]);
  });
});
