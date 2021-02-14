import {
  App,
  Notice,
  Plugin,
  Modal,
  PluginSettingTab,
  Setting,
  MarkdownView,
  ButtonComponent,
  ExtraButtonComponent,
  ToggleComponent,
} from 'obsidian';

const {spawn, Buffer, ChildProcess} = require('child_process');

interface LegacyShortcutEntry {
  regex: string;
  command?: string;
  replacement?: string;
}

interface LegacyTextExpanderPluginSettings {
  shortcuts: Array<LegacyShortcutEntry>;
  shell: string;
}

interface SnippetEntry {
  trigger: string;
  replacement: string;
}

interface FormatEntry {
  pattern: string;
  cut_start: number;
  cut_end: number;
}

interface TextExpanderPluginSettings {
  snippets: Array<SnippetEntry>;
  formats: Array<FormatEntry>;
  handler_command: string;
  is_custom_handler_enabled: boolean;
  is_migration_manager_enabled: boolean;
  legacy_settings: string | null;
  shell?: string;
  shortcuts?: Array<LegacyShortcutEntry>;
}

interface Context {
  vault_path: string;
  file_name: string;
  file_path: string;
  scripts_path: string;
}

const DEFAULT_SNIPPETS = [
  {
    trigger: "",
    replacement: ""
  }
];

const DEFAULT_FORMATS: Array<FormatEntry> = [
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

const DEFAULT_SETTINGS: TextExpanderPluginSettings = {
  snippets: DEFAULT_SNIPPETS,
  formats: DEFAULT_FORMATS,
  handler_command: 'python3 <scripts_path>/main.py',
  is_custom_handler_enabled: false,
  is_migration_manager_enabled: false,
  legacy_settings: null,
};

export default class TextExpanderPlugin extends Plugin {
  settings: TextExpanderPluginSettings;

  private codemirrorEditor: CodeMirror.Editor;

  private snippetLine: number;
  private snippetStart: number;
  private snippetEnd: number;

  private waiting: Boolean;
  private child: typeof ChildProcess;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new TextExpanderSettingTab(this.app, this));

    this.registerCodeMirror((codemirrorEditor: CodeMirror.Editor) => {
      codemirrorEditor.on('keydown', this.handleKeyDown);
    });

    this.spawnHandler();
  }

  onunload() {
    console.log("[Text Expander Plugin]", 'unloading');
    this.killHandler();
  }

  async loadSettings() {
    this.settings = Object.assign(Object.create(DEFAULT_SETTINGS), await this.loadData());
    this.loadLegacy()
  }

  async loadLegacy() {
    if (this.settings.legacy_settings != null) {
      return;
    }
    let legacy_settings: LegacyTextExpanderPluginSettings = {shortcuts: [], shell: ""};
    if (this.settings.shortcuts) {
      legacy_settings.shortcuts = this.settings.shortcuts;
    }
    if (this.settings.shell) {
      legacy_settings.shell = this.settings.shell;
    }
    this.settings.legacy_settings = JSON.stringify(legacy_settings, null, '\t');
    delete this.settings.shortcuts;
    delete this.settings.shell;
    this.saveSettings()
  }

  // async migrateSettings() {
  //   if (this.settings.shortcuts) {
  //     for (let item of this.settings.shortcuts) {
  //       let newEntry: SnippetEntry = {trigger: "", replacement: ""};
  //       if (item.regex) {
  //         newEntry.trigger = item.regex;
  //       }
  //       if (item.replacement) {
  //         newEntry.replacement = item.replacement;
  //       }
  //       this.settings.snippets.push(newEntry);
  //     }
  //     delete this.settings.shortcuts;
  //   }
  // }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  spawnHandler() {
    if (!this.settings.is_custom_handler_enabled) {
      return;
    }
    let handler_command = this.replaceContext(this.settings.handler_command);
    let argv = handler_command.split(RegExp('\\s+'));
    console.log("[Text Expander Plugin]", "spawning handler:", argv)
    this.child = spawn(argv[0], argv.slice(1));
    this.child.stdin.setEncoding('utf-8');
    this.child.stdout.on('data', this.handleSubprocessStdout);
    this.child.stderr.on('data', this.handleSubprocessStderr);

    this.child.on('close', (code: number) => {
      console.log("[Text Expander Plugin]", `child process closed all stdio with code ${code}`);
      // this.spawnHandler();
    });

    this.child.on('exit', (code: number) => {
      console.log("[Text Expander Plugin]", `child process exited with code ${code}`);
      // this.spawnHandler();
    });

    this.child.on('error', (err: Error) => {
      console.log(`"[Text Expander Plugin]", child process: error ${err}`);
      // this.spawnHandler();
    });

    process.on("exit", function() {
      this.killHandler()
    })
  }

  killHandler() {
    this.child.kill();
  }

  private readonly handleSubprocessStdout = (data: Buffer): void => {
    let response = JSON.parse(data.toString());
    if (this.waiting) {
      this.codemirrorEditor.replaceRange(
        response.replacement,
        {ch: this.snippetStart, line: this.snippetLine},
        {ch: this.snippetEnd, line: this.snippetLine}
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
    for (let entry of this.settings.formats) {
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
            this.replaceSnippet(line, start, end, cm, entry);
          }
        }
      }
    }
  };

  replaceSnippet(
    line: number,
    start: number,
    end: number,
    cm: CodeMirror.Editor,
    entry: FormatEntry
  ) {
    const content = cm.getRange(
      {line: line, ch: start + entry.cut_start},
      {line: line, ch: end - entry.cut_end}
    );

    let not_replaced_with_snippets = this.settings.snippets.every(
      (value: SnippetEntry): Boolean => {
        if (content == value.trigger) {
          cm.replaceRange(
            value.replacement,
            {ch: start, line: line},
            {ch: end, line: line}
          );
          return false;
        }
        return true;
      }
    );

    if (!this.settings.is_custom_handler_enabled) {
      return;
    }

    if (not_replaced_with_snippets) {
      this.waiting = true;
      this.codemirrorEditor = cm;
      this.snippetLine = line;
      this.snippetStart = start;
      this.snippetEnd = end;
      let request = {
        "id": 0,
        "text": content,
        "context": this.getContext()
      }
      this.child.stdin.write(JSON.stringify(request) + '\n');
    }
  }

  getContext(): Context {
    const active_view = this.app.workspace.getActiveViewOfType(
      MarkdownView
    );
    const vault_path = this.app.vault.adapter.basePath;
    var inner_path = null;
    var file_name = null;
    var file_path = null;
    if (active_view != null) {
      inner_path = active_view.file.parent.path;
      file_name = active_view.file.name;
      file_path = require('path').join(
        vault_path,
        inner_path,
        file_name
      );
    }
    const scripts_path = require('path').join(
      vault_path,
      '.obsidian',
      'scripts'
    );
    const result: Context = {
      "vault_path": vault_path,
      "file_name": file_name,
      "file_path": file_path,
      "scripts_path": scripts_path,
    }
    return result;
  }

  replaceContext(s: string): string {
    const context: Context = this.getContext();
    const contextKeys = [
      "vault_path",
      "file_name",
      "file_path",
      "scripts_path"
    ] as const;
    for (let key of contextKeys) {
      let value = context[key as typeof contextKeys[number]];
      s = this.replaceAll(s, "<" + key + ">", value);
    }
    return s;
  }

  replaceAll(s: string, search: string, replacement: string): string {
    const regex = RegExp(search, 'g');
    return s.replace(regex, replacement);
  }
}

class TextExpanderSettingTab extends PluginSettingTab {
  plugin: TextExpanderPlugin;

  constructor(app: App, plugin: TextExpanderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.renderFields();
  }

  renderFields() {
    const {containerEl} = this;
    containerEl.empty();

    let basicSettingsHeader = containerEl.createEl("h2").innerText = "Basic Settings";
    let snippetsHeader = containerEl.createEl("h3").innerText = "Snippets";
    let snippetsEl = containerEl.createEl("div");
    snippetsEl.setAttribute("class", "text-expander-options text-expander-snippets");
    snippetsEl.createEl("div").innerText = "Trigger";
    snippetsEl.createEl("div").innerText = "Replacement";
    snippetsEl.createEl("div");

    for (let key in this.plugin.settings.snippets) {
      new Setting(snippetsEl)
        .addText(text => {
          text
            .setPlaceholder("trigger")
            .setValue(this.plugin.settings.snippets[key]["trigger"])
            .onChange(async value => {
              this.plugin.settings.snippets[key]["trigger"] = value;
              await this.plugin.saveSettings();
            });
        });
      new Setting(snippetsEl)
        .addTextArea(text => {
          text
            .setPlaceholder("replacement")
            .setValue(this.plugin.settings.snippets[key]["replacement"])
            .onChange(async value => {
              this.plugin.settings.snippets[key]["replacement"] = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.cols = 40;
        });
      new ExtraButtonComponent(snippetsEl)
        .setIcon("cross")
        .onClick(() => {
          new SnippetRemovalConfirmationModal(this.plugin.app, this.plugin, this, +key).open();
        })
    }
    let addSnippetButtonWrapper = containerEl.createEl("div");
    addSnippetButtonWrapper.setAttribute("style", "display: flex; justify-content: center;");
    new ButtonComponent(addSnippetButtonWrapper)
      .setButtonText("New snippet")
      .setCta()
      .onClick(async () => {
        let newEntry: SnippetEntry = {trigger: "", replacement: ""};
        this.plugin.settings.snippets.push(newEntry);
        this.renderFields();
        await this.plugin.saveSettings();
      })
    containerEl.createEl("hr");

    let advancedSettingsHeader = containerEl.createEl("h2").innerText = "Advanced Settings";
    let formatsHeader = containerEl.createEl("h3").innerText = "Formats";
    let formatsEl = containerEl.createEl("div");
    formatsEl.setAttribute("class", "text-expander-options text-expander-formats");
    formatsEl.createEl("div").innerText = "Format";
    formatsEl.createEl("div").innerText = "Cut start";
    formatsEl.createEl("div").innerText = "Cut end";
    formatsEl.createEl("div");

    for (let key in this.plugin.settings.formats) {
      new Setting(formatsEl)
        .addText(text => {
          text
            .setPlaceholder("pattern")
            .setValue(this.plugin.settings.formats[key]["pattern"])
            .onChange(async value => {
              this.plugin.settings.formats[key]["pattern"] = value;
              await this.plugin.saveSettings();
            });
        });
      new Setting(formatsEl)
        .addText(text => {
          text
            .setPlaceholder("0")
            .setValue(String(this.plugin.settings.formats[key]["cut_start"]))
            .onChange(async value => {
              this.plugin.settings.formats[key]["cut_start"] = +value;
              await this.plugin.saveSettings();
            });
        });
      new Setting(formatsEl)
        .addText(text => {
          text
            .setPlaceholder("0")
            .setValue(String(this.plugin.settings.formats[key]["cut_end"]))
            .onChange(async value => {
              this.plugin.settings.formats[key]["cut_end"] = +value;
              await this.plugin.saveSettings();
            });
        });
      new ExtraButtonComponent(formatsEl)
        .setIcon("cross")
        .onClick(() => {
          new FormatRemovalConfirmationModal(this.plugin.app, this.plugin, this, +key).open();
        })
    }
    let addFormatButtonWrapper = containerEl.createEl("div");
    addFormatButtonWrapper.setAttribute("style", "display: flex; justify-content: center;");
    new ButtonComponent(addFormatButtonWrapper)
      .setButtonText("New format")
      .setCta()
      .onClick(async () => {
        let newEntry: FormatEntry = {pattern: "", cut_start: 0, cut_end: 0};
        this.plugin.settings.formats.push(newEntry);
        this.renderFields();
        await this.plugin.saveSettings();
      })

    containerEl.createEl("hr");

    containerEl.createEl("h3").innerText = "Custom handler";
    let enableCustomHandlerSetting = new Setting(containerEl)
      .setName('Enable custom handler')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.is_custom_handler_enabled)
          .onChange(async value => {
            this.plugin.settings.is_custom_handler_enabled = value;
            this.renderFields()
            await this.plugin.saveSettings();
          });
      });
    enableCustomHandlerSetting.settingEl.setAttribute("style", "border: none;");

    if (this.plugin.settings.is_custom_handler_enabled) {
      let customHandlerSetting = new Setting(containerEl)
        .setName('Handler command')
        .addTextArea(text => {
          text
            .setPlaceholder(DEFAULT_SETTINGS.handler_command)
            .setValue(this.plugin.settings.handler_command)
            .onChange(async value => {
              this.plugin.settings.handler_command = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.style.fontFamily = 'monospace';
          text.inputEl.cols = 40;
        });
      customHandlerSetting.settingEl.setAttribute("style", "border: none;");
    }

    containerEl.createEl("hr");

    containerEl.createEl("h3").innerText = "Migration manager";
    let enableMigrationManagerSetting = new Setting(containerEl)
      .setName('Enable migration manager')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.is_migration_manager_enabled)
          .onChange(async value => {
            this.plugin.settings.is_migration_manager_enabled = value;
            this.renderFields()
            await this.plugin.saveSettings();
          });
      });
    enableMigrationManagerSetting.settingEl.setAttribute("style", "border: none;");

    if (this.plugin.settings.is_migration_manager_enabled) {
      let legacySettingsField = new Setting(containerEl)
        .setName('Legacy settings')
        .addTextArea(text => {
          text.setValue(this.plugin.settings.legacy_settings)
          text.inputEl.style.fontFamily = 'monospace';
          text.inputEl.cols = 60;
          text.inputEl.rows = 30;
        })
        .setDisabled(true);
      legacySettingsField.settingEl.setAttribute("style", "border: none;");

      let migrateButtonWrapper = containerEl.createEl("div");
      migrateButtonWrapper.setAttribute("style", "display: flex; justify-content: center;");
      new ButtonComponent(migrateButtonWrapper)
        .setButtonText("Migrate replacements")
        .setCta()
        .onClick(async () => {
          new Notice("Migration manager is not implemented yet")
          // this.renderFields();
          // await this.plugin.saveSettings();
        })
    }
  }
}

class SnippetRemovalConfirmationModal extends Modal {
  plugin: TextExpanderPlugin;
  settingsTab: TextExpanderSettingTab;
  snippetId: number;

  constructor(app: App, plugin: TextExpanderPlugin, settingsTab: TextExpanderSettingTab, snippetId: number) {
    super(app);
    this.plugin = plugin;
    this.settingsTab = settingsTab;
    this.snippetId = snippetId;
  }

  onOpen() {
    let {contentEl} = this;
    let wrapperEl = contentEl
      .createEl("div")
    wrapperEl.setAttribute("style", "display: flex; flex-direction: column;")
    let promptEl = wrapperEl
      .createEl("div")
      .setText(`Are you sure you want to remove the snippet "${this.plugin.settings.snippets[this.snippetId]['trigger']}"?`);
    let buttonContainerEl = wrapperEl
      .createEl("div")
    buttonContainerEl.setAttribute("style", "margin-top: 1em; display: flex; justify-content: center;")
    new ButtonComponent(buttonContainerEl)
      .setButtonText("Cancel")
      .setCta()
      .onClick(() => {
        this.close();
      })
    new ButtonComponent(buttonContainerEl)
      .setButtonText("Remove")
      .onClick(async () => {
        this.plugin.settings.snippets.splice(this.snippetId, 1);
        this.close();
        this.settingsTab.renderFields();
        await this.plugin.saveSettings();
      })
  }

  onClose() {
    let {contentEl} = this;
    contentEl.empty();
  }
}

class FormatRemovalConfirmationModal extends Modal {
  plugin: TextExpanderPlugin;
  settingsTab: TextExpanderSettingTab;
  formatId: number;

  constructor(app: App, plugin: TextExpanderPlugin, settingsTab: TextExpanderSettingTab, formatId: number) {
    super(app);
    this.plugin = plugin;
    this.settingsTab = settingsTab;
    this.formatId = formatId;
  }

  onOpen() {
    let {contentEl} = this;
    let wrapperEl = contentEl
      .createEl("div")
    wrapperEl.setAttribute("style", "display: flex; flex-direction: column;")
    let promptEl = wrapperEl
      .createEl("div")
      .setText(`Are you sure you want to remove the format "${this.plugin.settings.formats[this.formatId]['pattern']}"?`);
    let buttonContainerEl = wrapperEl
      .createEl("div")
    buttonContainerEl.setAttribute("style", "margin-top: 1em; display: flex; justify-content: center;")
    new ButtonComponent(buttonContainerEl)
      .setButtonText("Cancel")
      .setCta()
      .onClick(() => {
        this.close();
      })
    new ButtonComponent(buttonContainerEl)
      .setButtonText("Remove")
      .onClick(async () => {
        this.plugin.settings.formats.splice(this.formatId, 1);
        this.close();
        this.settingsTab.renderFields();
        await this.plugin.saveSettings();
      })
  }

  onClose() {
    let {contentEl} = this;
    contentEl.empty();
  }
}
