import * as vscode from "vscode";
import { createSpec } from "../specManager.js";
import { readSteeringForContext } from "../steeringManager.js";
import { loadTasks, applyCompletedIds } from "../taskManager.js";
import { resolveChatModel } from "./modelResolver.js";

export async function generateSpecContent(
  specName: string,
  fileGlob: string,
  existingContext: string,
  section: "requirements" | "design" | "tasks",
  stream: vscode.ChatResponseStream,
): Promise<string> {
  const resolvedModel = await resolveChatModel();
  const model = resolvedModel?.model;
  if (!model || !resolvedModel) {
    stream.markdown(
      "\n> **Error:** No suitable Copilot model available. Install GitHub Copilot Chat and ensure an eligible high-capability model is available.\n",
    );
    return "";
  }

  stream.progress(
    `Using model: ${resolvedModel.descriptor} (matched by ${resolvedModel.matchedBy}${resolvedModel.isFallback ? ", fallback" : ""})`,
  );

  const steering = await readSteeringForContext();

  const sectionPrompts: Record<string, string> = {
    requirements: `
You are a software architect. Generate a requirements document for a feature called "${specName}".
The feature affects files matching: \`${fileGlob}\`.

Use EARS notation for acceptance criteria:
- WHEN [condition] THE SYSTEM SHALL [behavior]
- IF [precondition] WHEN [condition] THE SYSTEM SHALL [behavior]
- WHILE [state] THE SYSTEM SHALL [behavior]

Structure the document with:
1. Overview (2-3 sentences)
2. User Stories with Acceptance Criteria (at least 2 user stories)
3. Non-Functional Requirements
4. Out of Scope

Respond with ONLY the Markdown body (no frontmatter). Be specific and testable.`,

    design: `
You are a software architect. Generate a design document for a feature called "${specName}".
The feature affects files matching: \`${fileGlob}\`.

${existingContext ? `Requirements context:\n${existingContext}\n` : ""}

Structure the document with:
1. Architecture Overview
2. Components (with interfaces/types)
3. Data Flow (ASCII diagram)
4. Sequence Diagram (text format)
5. Error Handling table
6. Dependencies
7. Open Questions

Respond with ONLY the Markdown body (no frontmatter). Be specific and technical.`,

    tasks: `
You are a software architect. Generate a task breakdown for implementing the feature "${specName}".
The feature affects files matching: \`${fileGlob}\`.

${existingContext ? `Context:\n${existingContext}\n` : ""}

Rules:
- Use checkbox format: \`- [ ] <!-- task:T1 --> Task title\`
- Add a \`<!-- files: ${fileGlob} -->\` comment at the top
- Each top-level task should have 2-4 sub-tasks
- Tasks should be in implementation order
- Include a testing task and a documentation task
- Be concrete and actionable (no vague tasks)

Respond with ONLY the Markdown body (no frontmatter).`,
  };

  const systemMessage = steering
    ? `You are a helpful engineering assistant. Project context:\n\n${steering}`
    : "You are a helpful engineering assistant.";

  const messages = [
    vscode.LanguageModelChatMessage.Assistant(systemMessage),
    vscode.LanguageModelChatMessage.User(sectionPrompts[section]),
  ];

  let result = "";
  try {
    const response = await model.sendRequest(messages, {});
    for await (const chunk of response.text) {
      result += chunk;
      stream.markdown(chunk);
    }
  } catch (err) {
    stream.markdown(`\n> **Error generating ${section}:** ${err}\n`);
  }

  return result;
}

export async function generateFullSpec(
  specName: string,
  fileGlob: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  stream.markdown(
    `## Creating spec: **${specName}**\n\nGlob: \`${fileGlob}\`\n\n`,
  );

  // Capture existing completed task IDs before overwriting so we can restore them
  const { tasks: existingTasks } = await loadTasks(specName);
  const completedIds = new Set(
    existingTasks.filter((t) => t.completed).map((t) => t.id),
  );

  // Scaffold the files first
  try {
    await createSpec(specName, fileGlob);
  } catch (err) {
    stream.markdown(`> **Error creating spec files:** ${err}\n`);
    return;
  }

  // Generate requirements
  stream.markdown("### Requirements\n\n");
  const requirementsContent = await generateSpecContent(
    specName,
    fileGlob,
    "",
    "requirements",
    stream,
  );

  stream.markdown("\n\n### Design\n\n");
  const designContent = await generateSpecContent(
    specName,
    fileGlob,
    requirementsContent,
    "design",
    stream,
  );

  stream.markdown("\n\n### Tasks\n\n");
  const combinedContext = `Requirements:\n${requirementsContent}\n\nDesign:\n${designContent}`;
  const tasksGeneratedContent = await generateSpecContent(
    specName,
    fileGlob,
    combinedContext,
    "tasks",
    stream,
  );

  // Write generated content to files
  const { writeTextFile } = await import("../utils/fileSystem.js");
  const { requirementsUri, designUri, tasksUri } =
    await import("../utils/fileSystem.js");
  const { serializeFrontmatter } = await import("../utils/frontmatter.js");

  const reqUri = requirementsUri(specName);
  const dUri = designUri(specName);
  const taskFileUri = tasksUri(specName);

  if (reqUri) {
    const fm = {
      name: `${specName} Requirements`,
      applyTo: fileGlob,
      description: `Requirements for the ${specName} feature`,
    };
    await writeTextFile(reqUri, serializeFrontmatter(fm, requirementsContent));
  }
  if (dUri) {
    const fm = {
      name: `${specName} Design`,
      applyTo: fileGlob,
      description: `Architecture and design for the ${specName} feature`,
    };
    await writeTextFile(dUri, serializeFrontmatter(fm, designContent));
  }
  if (taskFileUri && tasksGeneratedContent) {
    const finalTasksContent =
      completedIds.size > 0
        ? applyCompletedIds(tasksGeneratedContent, completedIds, specName)
        : tasksGeneratedContent;
    await writeTextFile(taskFileUri, finalTasksContent);
  }

  stream.markdown(
    `\n\n---\n✅ Spec files created in \`.github/instructions/specs/${specName}/\` and \`.github/specs/${specName}/\`\n`,
  );
  const reqOpenUri = requirementsUri(specName);
  if (reqOpenUri) {
    stream.button({
      command: "vscode.open",
      arguments: [reqOpenUri],
      title: "Open Requirements",
    });
  }
}
