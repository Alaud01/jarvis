import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

class ConversationRecoveryError extends Error {
  readonly cause: unknown;

  constructor(id: string, options: { cause: unknown }) {
    super(`Conversation ${id} could not be read or recovered. Its files were preserved.`);
    this.cause = options.cause;
  }
}

/** Orders reads, writes, and deletes without blocking the Electron event loop. */
export class SerialTaskQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}

/** Existing JSON files stay readable; a previous valid snapshot enables recovery. */
export class ConversationFiles<T extends { id: string; messages: unknown[] }> {
  constructor(private readonly directory: string) {}

  private filePath(id: string): string {
    return path.join(this.directory, `${encodeURIComponent(id)}.json`);
  }

  private async readValid(file: string, id: string): Promise<T> {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as T;
    if (!value || value.id !== id || !Array.isArray(value.messages)) {
      throw new Error(`Invalid conversation file: ${file}`);
    }
    return value;
  }

  async read(id: string): Promise<T | null> {
    const file = this.filePath(id);
    try {
      return await this.readValid(file, id);
    } catch (primaryError) {
      try {
        const recovered = await this.readValid(`${file}.bak`, id);
        // Preserve the damaged file for diagnosis instead of overwriting it.
        await fs.rename(file, `${file}.corrupt-${randomUUID()}`).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        await this.atomicWrite(file, recovered);
        console.warn(`Recovered conversation ${id} from its previous snapshot.`);
        return recovered;
      } catch (backupError) {
        if ((primaryError as NodeJS.ErrnoException).code === 'ENOENT'
          && (backupError as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new ConversationRecoveryError(id, { cause: primaryError });
      }
    }
  }

  private async atomicWrite(file: string, value: T): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async write(value: T): Promise<void> {
    const previous = await this.read(value.id);
    if (previous) {
      // Copy the validated on-disk snapshot without stringifying a large history twice.
      const file = this.filePath(value.id);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.copyFile(file, temporary);
        const handle = await fs.open(temporary, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, `${file}.bak`);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
    await this.atomicWrite(this.filePath(value.id), value);
  }

  async delete(id: string): Promise<void> {
    await fs.rm(`${this.filePath(id)}.bak`, { force: true });
    await fs.rm(this.filePath(id), { force: true });
    const primaryName = path.basename(this.filePath(id));
    const names = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names) {
      if (name.startsWith(`${primaryName}.corrupt-`)
        || (name.startsWith(`${primaryName}.`) && name.endsWith('.tmp'))) {
        await fs.rm(path.join(this.directory, name), { force: true });
      }
    }
  }

  async prune(validIds: Set<string>): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const validNames = new Set([...validIds].map(id => path.basename(this.filePath(id))));
    for (const name of names) {
      const primaryName = name.endsWith('.json.bak') ? name.slice(0, -4) : name;
      if (primaryName.endsWith('.json') && !validNames.has(primaryName)) {
        await fs.rm(path.join(this.directory, name), { force: true });
      }
    }
  }
}
