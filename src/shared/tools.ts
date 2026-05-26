/**
 * shared/tools.ts
 *
 * OpenAI-compatible tool definitions for every DOM operation and browser
 * capability the agent can invoke.
 *
 * These are passed verbatim in the `tools[]` array of every
 * chatCompletion() call so the LLM knows exactly what it can do.
 *
 * Shape: OpenAI FunctionTool
 *   { type: "function", function: { name, description, parameters } }
 */

/** OpenAI-compatible JSON Schema subset used in tool parameters. */
export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "object" | "array" | "null";
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  minimum?: number;
  maximum?: number;
}

export interface ToolParametersSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
}

export interface Tool {
  type: "function";
  function: FunctionDefinition;
}

// ---------------------------------------------------------------------------
// Individual tool definitions
// ---------------------------------------------------------------------------

/** Click a DOM element identified by a CSS selector. */
const clickTool: Tool = {
  type: "function",
  function: {
    name: "click",
    description:
      "Click a DOM element on the current page identified by a CSS selector. " +
      "Use this to follow links, press buttons, or activate interactive elements. " +
      "If the element is inside a cross-origin iframe or requires a trusted event, " +
      "the operation automatically escalates to CDP.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description:
            "CSS selector for the element to click. " +
            "Prefer specific selectors (id, data attributes, aria-label) over fragile position-based ones.",
        },
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
};

/** Type text into an input or contenteditable element. */
const typeTool: Tool = {
  type: "function",
  function: {
    name: "type",
    description:
      "Type text into an input field, textarea, or contenteditable element. " +
      "Does NOT submit the form — call click() on the submit button separately.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the input element.",
        },
        text: {
          type: "string",
          description: "Text to type into the element.",
        },
        clear: {
          type: "boolean",
          description:
            "If true, clears the field before typing. Default: false.",
        },
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
  },
};

/** Fill multiple form fields in one call. */
const fillFormTool: Tool = {
  type: "function",
  function: {
    name: "fillForm",
    description:
      "Fill multiple form fields in a single operation. " +
      "Accepts a mapping of CSS selectors to the values to type. " +
      "Each field is cleared before typing. More efficient than multiple type() calls.",
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "object",
          description:
            "Object where each key is a CSS selector and each value is the text to fill in.",
          additionalProperties: {
            type: "string",
          },
        },
      },
      required: ["fields"],
      additionalProperties: false,
    },
  },
};

/** Scroll the page or a specific element into view. */
const scrollTool: Tool = {
  type: "function",
  function: {
    name: "scroll",
    description:
      "Scroll the page to a specific element or to absolute pixel coordinates. " +
      "Use selector when you want to bring a specific element into view. " +
      "Use x/y when you need to scroll to a known position.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description:
            "CSS selector of the element to scroll into view. " +
            "Mutually exclusive with x/y.",
        },
        x: {
          type: "number",
          description:
            "Horizontal scroll offset in pixels. Used when selector is absent.",
        },
        y: {
          type: "number",
          description:
            "Vertical scroll offset in pixels. Used when selector is absent.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

/** Read the main content of the current page as clean markdown. */
const readPageTool: Tool = {
  type: "function",
  function: {
    name: "readPage",
    description:
      "Extract the main textual content of the current page and return it as clean markdown. " +
      "Strips boilerplate (navigation, ads, footers) and retains headings, paragraphs, lists, and links. " +
      "Use this to understand what is on the page before acting on it.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

/** Wait for a selector to appear in the DOM. */
const waitForSelectorTool: Tool = {
  type: "function",
  function: {
    name: "waitForSelector",
    description:
      "Wait for a CSS selector to appear in the DOM before continuing. " +
      "Useful after navigation or after triggering async UI changes. " +
      "Returns when the element appears or times out.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to wait for.",
        },
        timeout: {
          type: "number",
          description:
            "Maximum time to wait in milliseconds. Default: 5000. Maximum: 30000.",
          minimum: 100,
          maximum: 30000,
        },
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
};

/** Get the URL of the current tab. */
const getUrlTool: Tool = {
  type: "function",
  function: {
    name: "getUrl",
    description:
      "Return the full URL of the currently active tab. " +
      "Useful to confirm navigation succeeded or to check the current context before acting.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

/** Get the user's currently selected text. */
const getSelectionTool: Tool = {
  type: "function",
  function: {
    name: "getSelection",
    description:
      "Return the text currently selected (highlighted) by the user in the active tab. " +
      "Returns an empty string if nothing is selected.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

/** Take a screenshot of the current tab (CDP-escalated). */
const screenshotTool: Tool = {
  type: "function",
  function: {
    name: "screenshot",
    description:
      "Capture a screenshot of the current tab as a base64-encoded PNG data URL. " +
      "This always uses the Chrome DevTools Protocol (CDP) regardless of cross-origin state. " +
      "Use sparingly — screenshots are large and count against token limits.",
    parameters: {
      type: "object",
      properties: {
        quality: {
          type: "number",
          description:
            "JPEG quality 0–100. Only used when format is 'jpeg'. Default: 80.",
          minimum: 0,
          maximum: 100,
        },
        format: {
          type: "string",
          enum: ["png", "jpeg"],
          description: "Image format. Default: 'png'.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

// ---------------------------------------------------------------------------
// Export the full tools array
// ---------------------------------------------------------------------------

/** All tools available to the agent, in the order they are presented to the LLM. */
export const AGENT_TOOLS: Tool[] = [
  readPageTool,    // cheapest — read first, then act
  getUrlTool,      // lightweight context check
  getSelectionTool,
  clickTool,
  typeTool,
  fillFormTool,
  scrollTool,
  waitForSelectorTool,
  screenshotTool,  // most expensive — last
];

/** Look up a tool definition by name. */
export function getToolByName(name: string): Tool | undefined {
  return AGENT_TOOLS.find((t) => t.function.name === name);
}

/** Names of tools that must always be dispatched via CDP (never content-script). */
export const CDP_ONLY_TOOLS = new Set<string>(["screenshot"]);

/** Names of tools that should attempt content-script first, then escalate to CDP. */
export const CONTENT_FIRST_TOOLS = new Set<string>([
  "click",
  "type",
  "fillForm",
  "scroll",
  "waitForSelector",
  "readPage",
  "getUrl",
  "getSelection",
]);
