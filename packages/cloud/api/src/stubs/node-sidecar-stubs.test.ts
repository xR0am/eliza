/**
 * Exercises the Worker shims for Node-only toolchains through their real
 * surfaces: every real-call path must throw an error that routes the operator
 * to the package that actually hosts the work (document extraction in the
 * assistant plugin, Docker node SSH in cloud-shared's docker-ssh), and never
 * point at a workspace that does not do this work or a document that does not
 * exist in the tree (observed with the removed cloud/INFRA.md reference and
 * an inaccurate agent-server pointer).
 */
import { describe, expect, test } from "bun:test";
import {
  convertToHtml,
  convertToMarkdown,
  embedStyleMap,
  extractRawText,
  images as mammothImages,
} from "./mammoth";
import { Client, Server, utils as ssh2Utils } from "./ssh2";
import {
  definePDFJSModule,
  extractImages,
  extractText,
  getDocumentProxy,
  getMeta,
  getResolvedPDFJS,
  renderPageAsImage,
} from "./unpdf";

const ASSISTANT_PLUGIN_POINTER = /plugins\/plugin-assistant/;
const DOCKER_SSH_POINTER =
  /packages\/cloud\/shared\/src\/lib\/services\/docker-ssh\.ts/;
const REMOVED_INFRA_DOC = /cloud\/INFRA\.md/;
const INACCURATE_AGENT_SERVER_POINTER =
  /packages\/cloud\/services\/agent-server/;

const mammothEntryPoints = [
  ["extractRawText", extractRawText],
  ["convertToHtml", convertToHtml],
  ["convertToMarkdown", convertToMarkdown],
  ["embedStyleMap", embedStyleMap],
] as const;

const unpdfEntryPoints = [
  ["extractText", extractText],
  ["getDocumentProxy", getDocumentProxy],
  ["definePDFJSModule", definePDFJSModule],
  ["getResolvedPDFJS", getResolvedPDFJS],
  ["extractImages", extractImages],
  ["renderPageAsImage", renderPageAsImage],
  ["getMeta", getMeta],
] as const;

describe("mammoth stub", () => {
  test.each(mammothEntryPoints)(
    "%s rejects a Worker-side call",
    (_name, fn) => {
      expect(() => fn()).toThrow(/not available on Cloudflare Workers/);
      expect(() => fn()).toThrow(ASSISTANT_PLUGIN_POINTER);
      expect(() => fn()).not.toThrow(REMOVED_INFRA_DOC);
      expect(() => fn()).not.toThrow(INACCURATE_AGENT_SERVER_POINTER);
    },
  );

  test("images proxy rejects any property access", () => {
    expect(() => Reflect.get(mammothImages, "any")).toThrow(ASSISTANT_PLUGIN_POINTER);
    expect(() => Reflect.get(mammothImages, "any")).not.toThrow(REMOVED_INFRA_DOC);
    expect(() => Reflect.get(mammothImages, "any")).not.toThrow(
      INACCURATE_AGENT_SERVER_POINTER,
    );
  });
});

describe("unpdf stub", () => {
  test.each(unpdfEntryPoints)("%s rejects a Worker-side call", (_name, fn) => {
    expect(() => fn()).toThrow(/not available on Cloudflare Workers/);
    expect(() => fn()).toThrow(ASSISTANT_PLUGIN_POINTER);
    expect(() => fn()).not.toThrow(REMOVED_INFRA_DOC);
    expect(() => fn()).not.toThrow(INACCURATE_AGENT_SERVER_POINTER);
  });
});

describe("ssh2 stub", () => {
  test("Client construction rejects a Worker-side call", () => {
    expect(() => new Client()).toThrow(/not available on Cloudflare Workers/);
    expect(() => new Client()).toThrow(DOCKER_SSH_POINTER);
    expect(() => new Client()).not.toThrow(REMOVED_INFRA_DOC);
    expect(() => new Client()).not.toThrow(INACCURATE_AGENT_SERVER_POINTER);
  });

  test("Server construction rejects a Worker-side call", () => {
    expect(() => new Server()).toThrow(DOCKER_SSH_POINTER);
    expect(() => new Server()).not.toThrow(REMOVED_INFRA_DOC);
    expect(() => new Server()).not.toThrow(INACCURATE_AGENT_SERVER_POINTER);
  });

  test("utils proxy rejects any property access", () => {
    expect(() => Reflect.get(ssh2Utils, "connect")).toThrow(DOCKER_SSH_POINTER);
    expect(() => Reflect.get(ssh2Utils, "connect")).not.toThrow(REMOVED_INFRA_DOC);
    expect(() => Reflect.get(ssh2Utils, "connect")).not.toThrow(
      INACCURATE_AGENT_SERVER_POINTER,
    );
  });
});
