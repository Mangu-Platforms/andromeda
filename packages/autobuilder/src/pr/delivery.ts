import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { GeneratedFile } from "../templates/types.ts";

export interface DeliveryRequest {
  projectName: string;
  files: GeneratedFile[];
  /** Human who approved this delivery. Recorded at the destination. */
  approvedBy: string;
}

export interface DeliveryReceipt {
  target: string;
  location: string;
  fileCount: number;
}

/**
 * Where an approved build goes.
 *
 * This is the only component in the pipeline that performs an irreversible,
 * outward-facing action, which is why it sits behind its own interface and is
 * only ever reached after `ApprovalGate` has recorded a named human's decision.
 * `LocalDirectoryDelivery` writes to disk; a GitHub implementation would push a
 * branch and open a pull request through the same seam.
 */
export interface DeliveryTarget {
  readonly name: string;
  deliver(request: DeliveryRequest): Promise<DeliveryReceipt>;
}

export class LocalDirectoryDelivery implements DeliveryTarget {
  readonly name = "local-directory";
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryReceipt> {
    const destination = join(this.#root, request.projectName);
    for (const file of request.files) {
      const absolute = resolve(destination, file.path);
      const rel = relative(destination, absolute);
      if (rel.startsWith("..") || rel.startsWith(`${sep}..`)) {
        throw new Error(`refusing to write outside the destination: ${file.path}`);
      }
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.contents, "utf8");
    }
    return { target: this.name, location: destination, fileCount: request.files.length };
  }
}

/** Records what would have been delivered. Used by dry runs and by tests. */
export class NullDelivery implements DeliveryTarget {
  readonly name = "none";
  readonly delivered: DeliveryRequest[] = [];

  async deliver(request: DeliveryRequest): Promise<DeliveryReceipt> {
    this.delivered.push(request);
    return { target: this.name, location: "(not written)", fileCount: request.files.length };
  }
}
