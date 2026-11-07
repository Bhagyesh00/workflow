/**
 * The human review gate on a tool: a send-and-wait node in front of the tools it guards.
 *
 * The model sees each gated tool under its own name, with its arguments under `toolParameters` and the review
 * node's `$fromAI` values under `hitlParameters`. A call only sends the message and stops the run. What runs the
 * tool is `answerReview`, which the agent calls with the answer the engine got back: `hitlApproved` alone decides,
 * and the model's arguments never reach that method.
 *
 * Tools run in parallel, so a call has its own context and touches none of the engine's per-task fields.
 */
import { randomUUID } from 'node:crypto';
import {
  type AiTool,
  type DataObject,
  type ExecuteContext,
  type ExecuteData,
  extractFromAiArguments,
  fromAiSchema,
  fromAiVariables,
  type GetNodeParameterOptions,
  hitlApproved,
  isToolNode,
  type Item,
  type JsonSchema,
  NodeOperationError,
  type NodeType,
  ToolSuspension,
  type WorkflowNode,
} from '@workflow/workflow';
import type { ToolRunHost } from './node-as-tool';
import { assertValidOutput, type ContextDeps, createBaseContext, createExecuteContext } from './node-context';

/** a gate's tool: the agent's way back in once the person has answered */
export interface HitlGatedTool extends AiTool {
  answerReview(
    args: DataObject,
    answer: Item[][] | null,
    options: { signal?: AbortSignal; toolCallId: string },
  ): Promise<unknown>;
}

/**
 * What stands for the node in the links of one review. The run index keeps a link to its own wait: the URL of an
 * answered review cannot answer the next review on the same node.
 */
export function reviewNodeKey(node: WorkflowNode, runIndex: number): string {
  return `${node.webhookId || node.id}-${runIndex}`;
}

const isPlainObject = (value: unknown): value is DataObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isAiTool = (value: unknown): value is AiTool =>
  isPlainObject(value) && (value as { kind?: unknown }).kind === 'tool';

/** the person's text when the channel takes one, as a chat does */
function feedbackOf(answer: Item[][] | null): string | undefined {
  const text = answer?.[0]?.[0]?.json.chatInput;
  return typeof text === 'string' && text.trim() ? text : undefined;
}

function denialText(tool: string, toolCallId: string, answer: Item[][] | null): string {
  const feedback = feedbackOf(answer);
  return feedback
    ? `The user reviewed your planned tool call to ${tool} (id: ${toolCallId}) and provided feedback: "${feedback}". The tool is still available if needed.`
    : `User rejected the tool call to ${tool} (id: ${toolCallId}). STOP what you are doing and wait for the user to tell you how to proceed. The tool is still available if needed.`;
}

export async function createHitlGate(
  host: ToolRunHost,
  hitlNode: WorkflowNode,
  hitlType: NodeType,
  parent: WorkflowNode,
  parentExec: ExecuteData,
  itemIndex: number,
  signal: AbortSignal,
  closeFunctions: Array<() => Promise<void>>,
): Promise<AiTool[]> {
  if (isToolNode(host.workflow.getNodeType(parent).description)) {
    throw new NodeOperationError(
      hitlNode,
      `Human-in-the-Loop nodes cannot be used inside a sub-agent. Move "${hitlNode.name}" to the top-level workflow.`,
    );
  }
  const { execute } = hitlType;
  if (!execute) throw new NodeOperationError(hitlNode, `Node "${hitlNode.name}" cannot run as a tool`);

  const supplied = await host.supplySubNodes(
    hitlNode,
    hitlType,
    'ai_tool',
    itemIndex,
    parentExec,
    signal,
    closeFunctions,
  );
  const gatedTools = (Array.isArray(supplied) ? supplied : [supplied]).flat(2).filter(isAiTool);

  const declared = extractFromAiArguments(hitlNode.parameters);
  const hitlSchema = fromAiSchema(hitlNode.parameters);
  const parentItems = parentExec.data.main?.[0] ?? [];

  /** runs the review node's `execute` for one call: the message goes out, the node names when the wait ends */
  const sendForReview = async (
    gated: AiTool,
    toolParameters: DataObject,
    hitlParameters: DataObject,
    callSignal: AbortSignal,
  ): Promise<Date> => {
    // the node's links carry the run this wait gets: the engine writes it at the end of the node's runs
    const runIndex = host.state.resultData.runData[hitlNode.name]?.length ?? 0;
    const node: WorkflowNode = { ...hitlNode, webhookId: reviewNodeKey(hitlNode, runIndex) };
    const item = parentItems[itemIndex] ?? { json: {} };
    const exec: ExecuteData = {
      node: hitlNode.name,
      data: { main: [[{ ...item, pairedItem: { item: itemIndex } }]] },
      source: parentExec.source,
    };
    const extraVariables = {
      ...fromAiVariables(hitlParameters),
      $tool: { name: gated.name, parameters: toolParameters },
    };
    const withVariables = (execData: ExecuteData): ContextDeps => ({
      ...host.contextDeps(node, execData, runIndex, callSignal),
      extraVariables,
    });
    // expressions read at the agent's index, in the agent's input: the node itself asks for item 0 of its one item
    const reader = createBaseContext(withVariables({ ...exec, data: parentExec.data }));
    let waitTill: Date | undefined;
    const ctx: ExecuteContext = {
      ...createExecuteContext(withVariables(exec), {
        getInputConnectionData: (type) =>
          host.supplySubNodes(hitlNode, hitlType, type, itemIndex, parentExec, callSignal, closeFunctions),
        putExecutionToWait: (time) => {
          waitTill = time;
        },
        continueOnFail: () => false,
        addExecutionHints: () => {},
      }),
      getNodeParameter: (
        parameter: string,
        _index: number,
        fallback?: unknown,
        options?: GetNodeParameterOptions,
      ) => reader.getNodeParameter(parameter, itemIndex, fallback, options),
      evaluateExpression: (expression: string) => reader.evaluateExpression(expression, itemIndex),
    };
    const output = await execute.call(hitlType, ctx);
    assertValidOutput(hitlNode, output);
    // nothing else can stand for an answer: a node that does not wait approves nothing
    if (!waitTill) {
      throw new NodeOperationError(hitlNode, `Human review node "${hitlNode.name}" did not wait for an answer`);
    }
    return waitTill;
  };

  return gatedTools.map((gated): HitlGatedTool => {
    const parameters: JsonSchema = {
      type: 'object',
      properties: { toolParameters: gated.parameters, hitlParameters: hitlSchema },
      required: ['toolParameters', ...(hitlSchema.required ? ['hitlParameters'] : [])],
    };
    return {
      kind: 'tool',
      name: gated.name,
      description: gated.description,
      parameters,
      canWait: true,
      async invoke(args, options) {
        const toolCallId = options?.toolCallId ?? randomUUID();
        const toolParameters = isPlainObject(args.toolParameters) ? args.toolParameters : {};
        const sentHitl = isPlainObject(args.hitlParameters) ? args.hitlParameters : {};
        const entries: Array<[string, unknown]> = [];
        for (const { key, defaultValue } of declared) {
          const value = Object.hasOwn(sentHitl, key) ? sentHitl[key] : defaultValue;
          if (value !== undefined) entries.push([key, value]);
        }
        const values = Object.fromEntries(entries) as DataObject;
        const callSignal = options?.signal ? AbortSignal.any([signal, options.signal]) : signal;
        let waitTill: Date;
        try {
          waitTill = await sendForReview(gated, toolParameters, values, callSignal);
        } catch (error) {
          host.logSubNodeRun(hitlNode, parent, 'ai_tool', args, {}, error as Error);
          throw error;
        }
        throw new ToolSuspension({
          toolNode: hitlNode.name,
          waitTill,
          toolName: gated.name,
          toolCallId,
          gatedTool: { name: gated.name, arguments: toolParameters },
        });
      },
      async answerReview(args, answer, options) {
        if (!hitlApproved(answer)) return denialText(gated.name, options.toolCallId, answer);
        return gated.invoke(args, { signal: options.signal, toolCallId: options.toolCallId });
      },
    };
  });
}
