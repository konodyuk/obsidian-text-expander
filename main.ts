import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
} from 'obsidian';

const {spawn, Buffer, ChildProcess} = require('child_process');

interface ShortcutEntry {
  regex: string;
  command?: string;
  replacement?: string;
}

interface TextExpanderPluginSettings {
  shortcuts: Array<ShortcutEntry>;
  shell: string;
}

interface PatternEntry {
  pattern: string;
  cut_start: number;
  cut_end: number;
}

const DEFAULT_SHORTCUTS = [
  {
    regex: '^trigger$',
    replacement: '## Example replacement\n- [ ] ',
  },
  {
    regex: '^now$',
    command: 'printf `date +%H:%M`',
  },
  {
    regex: '^py:',
    command: 'echo <text> | cut -c 4- | python3',
  },
  {
    regex: '^eval:',
    command:
      'echo <text> | cut -c 6- | python3 -c \'print(eval(input()), end="")\'',
  },
  {
    regex: '^shell:',
    command: 'echo <text> | cut -c 7- | sh',
  },
  {
    regex: '^tool:',
    command: 'echo <text> | cut -c 6- | python3 <scripts_path>/tool.py',
  },
  {
    regex: '^sympy:',
    command: 'echo <text> | cut -c 7- | python3 <scripts_path>/sympy_tool.py',
  },
];

const DEFAULT_SETTINGS: TextExpanderPluginSettings = {
  shortcuts: DEFAULT_SHORTCUTS,
  shell: '/bin/sh',
};

export default class TextExpanderPlugin extends Plugin {
  settings: TextExpanderPluginSettings;

  private codemirrorEditor: CodeMirror.Editor;

  private shortcutLine: number;
  private shortcutStart: number;
  private shortcutEnd: number;

  private waiting: Boolean;
  private child: typeof ChildProcess;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new TextExpanderSettingTab(this.app, this));

    this.registerCodeMirror((codemirrorEditor: CodeMirror.Editor) => {
      codemirrorEditor.on('keydown', this.handleKeyDown);
    });

    this.spawnShell();
  }

  onunload() {
    console.log('unloading plugin');
  }

  async loadSettings() {
    this.settings = Object.assign(DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  spawnShell() {
    this.child = spawn(this.settings.shell);
    this.child.stdin.setEncoding('utf-8');
    this.child.stdout.on('data', this.handleSubprocessStdout);
    this.child.stderr.on('data', this.handleSubprocessStderr);

    // this.child.on('close', (code: number) => {
    //   console.log(`child process closed all stdio with code ${code}`);
    //   this.spawnShell();
    // });

    // this.child.on('exit', (code: number) => {
    //   console.log(`child process exited with code ${code}`);
    //   this.spawnShell();
    // });

    // this.child.on('error', (err: Error) => {
    //   console.log(`child process: error ${err}`);
    //   this.spawnShell();
    // });
  }

  private readonly handleSubprocessStdout = (data: Buffer): void => {
    if (this.waiting) {
      this.codemirrorEditor.replaceRange(
        data.toString(),
        {ch: this.shortcutStart, line: this.shortcutLine},
        {ch: this.shortcutEnd, line: this.shortcutLine}
      );
      this.waiting = false;
    }
  };

  private readonly handleSubprocessStderr = (data: Buffer): void => {
    new Notice(data.toString());
  };

  private readonly handleKeyDown = (
    cm: CodeMirror.Editor,
    event: KeyboardEvent
  ): void => {
    // const pattern = "{{[^{}]*}}";
    const patterns: Array<PatternEntry> = [
      {
        pattern: '{{(?:(?!{{|}}).)*?}}',
        cut_start: 2,
        cut_end: 2
      },
      {
        pattern: ':[^\\s]*',
        cut_start: 1,
        cut_end: 0
      }
    ]
    for (let entry of patterns) {
      let pattern = entry.pattern;
      const regex = RegExp(pattern, 'g');
      if (event.key === 'Tab') {
        const cursor = cm.getCursor();
        const {line} = cursor;
        const lineString = cm.getLine(line);
        let match;
        while ((match = regex.exec(lineString)) !== null) {
          const start = match.index;
          const end = match.index + match[0].length;
          if (start <= cursor.ch && cursor.ch <= end) {
            event.preventDefault();
            // Commented out, as it caused error in case if shortcut commend
            // did not write to stdout. Example: {{now}} won't work after {{shell:true}}
            // if (this.waiting) {
            // 	new Notice("Cannot process two shortcuts in parallel");
            // 	return;
            // }
            this.replaceShortcut(line, start, end, cm, entry);
          }
        }
      }
    }
  };

  replaceShortcut(
    line: number,
    start: number,
    end: number,
    cm: CodeMirror.Editor,
    entry: PatternEntry
  ) {
    const content = cm.getRange(
      {line: line, ch: start + entry.cut_start},
      {line: line, ch: end - entry.cut_end}
    );

    this.settings.shortcuts.every(
      (value: ShortcutEntry): Boolean => {
        const regex = RegExp(value.regex);
        if (regex.test(content)) {
          if (value.replacement) {
            cm.replaceRange(
              value.replacement,
              {ch: start, line: line},
              {ch: end, line: line}
            );
            return false;
          }
          if (value.command) {
            this.waiting = true;
            this.codemirrorEditor = cm;
            this.shortcutLine = line;
            this.shortcutStart = start;
            this.shortcutEnd = end;
            let command = value.command;

            const active_view = this.app.workspace.getActiveViewOfType(
              MarkdownView
            );
            if (active_view === null) {
              throw new Error('No active view found');
            }
            const vault_path = this.app.vault.adapter.basePath;
            const inner_path = active_view.file.parent.path;
            const file_name = active_view.file.name;
            const file_path = require('path').join(
              vault_path,
              inner_path,
              file_name
            );
            const scripts_path = require('path').join(
              vault_path,
              '.obsidian',
              'scripts'
            );
            command = replaceAll(
              command,
              '<text>',
              "'" + shellEscape(content) + "'"
            );
            command = replaceAll(command, '<text_raw>', content);
            command = replaceAll(command, '<vault_path>', vault_path);
            command = replaceAll(command, '<inner_path>', inner_path);
            command = replaceAll(command, '<note_name>', file_name);
            command = replaceAll(command, '<note_path>', file_path);
            command = replaceAll(command, '<scripts_path>', scripts_path);
            this.child.stdin.write(command + '\n');
            return false;
          }
        }
        return true;
      }
    );
  }
}

function shellEscape(cmd: string) {
  return replaceAll(cmd, "'", "'\"'\"'");
}

function replaceAll(s: string, search: string, replacement: string) {
  const regex = RegExp(search, 'g');
  return s.replace(regex, replacement);
}

class TextExpanderSettingTab extends PluginSettingTab {
  plugin: TextExpanderPlugin;

  constructor(app: App, plugin: TextExpanderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const {containerEl} = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName('Shortcuts')
      .setDesc(this.shortcutsHelp())
      .addTextArea(text => {
        text
          .setPlaceholder(JSON.stringify(DEFAULT_SETTINGS, null, '\t'))
          .setValue(JSON.stringify(this.plugin.settings.shortcuts, null, '\t'))
          .onChange(async value => {
            this.plugin.settings.shortcuts = JSON.parse(value);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 20;
        text.inputEl.cols = 60;
        text.inputEl.style.fontFamily = 'monospace';
      });

    new Setting(containerEl)
      .setName('Shell executable')
      .setDesc('All commands will be executed inside it.')
      .addText(text => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.shell)
          .setValue(this.plugin.settings.shell)
          .onChange(async value => {
            this.plugin.settings.shell = value;
            this.plugin.spawnShell();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.fontFamily = 'monospace';
      });
  }

  private shortcutsHelp(): DocumentFragment {
    const descEl = document.createDocumentFragment();
    descEl.appendText('Are defined as a JSON-list. Fields:');
    descEl.createEl('br');
    descEl.createEl('b').innerText = 'regex';
    descEl.appendText(' (required) - trigger pattern');
    descEl.createEl('br');
    descEl.createEl('b').innerText = 'replacement';
    descEl.appendText(' (optional) - text replacement, used if provided');
    descEl.createEl('br');
    descEl.createEl('b').innerText = 'command';
    descEl.appendText(
      ' (optional) - shell command whose stdout is used as a replacement'
    );
    return descEl;
  }
}
