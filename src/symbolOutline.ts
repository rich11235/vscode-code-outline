import { Range, Event, EventEmitter, ExtensionContext, SymbolKind, SymbolInformation, TextDocument, TextEditor, TreeDataProvider, TreeItem, TreeItemCollapsibleState, commands, window, workspace } from 'vscode';
import * as path from 'path';

let optsSortOrder: number[] = [];
let optsTopLevel: number[] = [];
let optsExpandNodes: number[] = [];
let optsDoSort = true;
let optsDoSelect = true;
let optsMarkPrivates = true;

export class SymbolNode {
    symbol: SymbolInformation;
    children?: SymbolNode[];
    isPrivate: boolean;

    constructor(symbol?: SymbolInformation) {
        this.children = [];
        this.symbol = symbol;
        this.isPrivate = false;
    }

    /**
     * Judge if a node should be expanded automatically.
     * @param kind
     */
    public static shouldAutoExpand(kind: SymbolKind): boolean {
        let ix = optsExpandNodes.indexOf(kind);
        if (ix < 0) {
            ix = optsExpandNodes.indexOf(-1);
        }
        return ix > -1;
    }

    private getKindOrder(kind: SymbolKind): number {
        let ix = optsSortOrder.indexOf(kind);
        if (ix < 0) {
            ix = optsSortOrder.indexOf(-1);
        }
        return ix;
    }

    private compareSymbols(a: SymbolNode, b: SymbolNode): number {
        const kindOrder = this.getKindOrder(a.symbol.kind) - this.getKindOrder(b.symbol.kind);
        if (kindOrder !== 0) {
            return kindOrder;
        }
        if (a.symbol.name.toLowerCase() > b.symbol.name.toLowerCase()) {
            return 1;
        }
        return -1;
    }

    /**
     * set the isPrivate property of the symbol if this SymbolNode
     * is a constructor, function, or method with a 'private' modifier.
     * else set isPrivate to false.
     * @param editor - the handle to the current editor file in focus
     */
    checkIfPrivate(editor: TextEditor) {
        switch (this.symbol.kind) {
            case SymbolKind.Constructor:
            case SymbolKind.Function:
            case SymbolKind.Method:
                // parse the current editor file and determine if this function is public or private.
                // also use simple search rather than regex for faster performance
                let snippet = editor.document.getText(this.symbol.location.range);
                let idxPrivate = snippet.indexOf('private');

                // if the 'private' modifier appears before the function name, then set the isPrivate property
                this.isPrivate = ((idxPrivate >= 0) && (idxPrivate <= snippet.indexOf(this.symbol.name)));
                break;
            default:
                // skip other kinds
                break;
        }
    }

    sort() {
        this.children.sort(this.compareSymbols.bind(this));
        this.children.forEach(child => child.sort());
    }

    addChild(child: SymbolNode) {
        this.children.push(child);
    }
}

export class SymbolOutlineProvider implements TreeDataProvider<SymbolNode> {
    private _onDidChangeTreeData: EventEmitter<SymbolNode | null> = new EventEmitter<SymbolNode | null>();
    readonly onDidChangeTreeData: Event<SymbolNode | null> = this._onDidChangeTreeData.event;

    private context: ExtensionContext;
    private tree: SymbolNode;
    private editor: TextEditor;

    private getSymbols(document: TextDocument): Thenable<SymbolInformation[]> {
        return commands.executeCommand<SymbolInformation[]>('vscode.executeDocumentSymbolProvider', document.uri);
    }

    private compareSymbols(a: SymbolNode, b: SymbolNode) {
        const startComparison = a.symbol.location.range.start.compareTo(b.symbol.location.range.start);
        if (startComparison != 0) {
            return startComparison;
        }
        return b.symbol.location.range.end.compareTo(a.symbol.location.range.end);
    }

    private async updateSymbols(editor: TextEditor): Promise<void> {
        const tree = new SymbolNode();
        this.editor = editor;
        if (editor) {
            readOpts();
            let symbols = await this.getSymbols(editor.document);
            if (optsTopLevel.indexOf(-1) < 0) {
               symbols = symbols.filter(sym => optsTopLevel.indexOf(sym.kind) >= 0);
            }
            // Create symbol nodes
            const symbolNodes: SymbolNode[] = symbols.map(symbol => new SymbolNode(symbol));
            // Sort nodes by left edge ascending and right edge descending
            symbolNodes.sort(this.compareSymbols);
            // Start with an empty list of parent candidates
            let potentialParents: SymbolNode[] = [];
            symbolNodes.forEach(currentNode => {
                // Drop candidates that do not contain the current symbol range
                potentialParents = potentialParents
                .filter(node => node !== currentNode && node.symbol.location.range.contains(currentNode.symbol.location.range))
                .sort(this.compareSymbols);
                // See if any candidates remain
                if (!potentialParents.length) {
                    tree.addChild(currentNode);
                } else {
                    const parent = potentialParents[potentialParents.length - 1];
                    parent.addChild(currentNode);
                }
                // Add current node as a parent candidate
                potentialParents.push(currentNode);

                // check if this node is a private function
                if (optsMarkPrivates) {
                    currentNode.checkIfPrivate(editor);
                }
            });
            if (optsDoSort) {
                tree.sort();
            }
        }
        this.tree = tree;
    }

    constructor(context: ExtensionContext) {
        this.context = context;
        window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                this.refresh();
            }
        });
        workspace.onDidCloseTextDocument(document => {
            if (!this.editor.document) {
                this.refresh();
            }
        });
        workspace.onDidChangeTextDocument(event => {
            if (!event.document.isDirty && event.document === this.editor.document) {
                this.refresh();
            }
        });
        workspace.onDidSaveTextDocument(document => {
            if (document === this.editor.document) {
                this.refresh();
            }
        });
    }

    async getChildren(node?: SymbolNode): Promise<SymbolNode[]> {
        if (node) {
            return node.children;
        } else {
            await this.updateSymbols(window.activeTextEditor);
            return this.tree ? this.tree.children : [];
        }
    }

    private getIcon(node: SymbolNode): {dark: string; light: string} {
        let icon: string;
        switch (node.symbol.kind) {
            case SymbolKind.Class:
                icon = 'class';
                break;
            case SymbolKind.Constant:
                icon = 'constant';
                break;
            case SymbolKind.Constructor:
            case SymbolKind.Function:
            case SymbolKind.Method:
                icon = (node.isPrivate) ? 'function-private' : 'function';
                break;
            case SymbolKind.Interface:
                icon = 'interface';
            case SymbolKind.Module:
            case SymbolKind.Namespace:
            case SymbolKind.Object:
            case SymbolKind.Package:
                icon = 'module';
                break;
            case SymbolKind.Property:
                icon = 'property';
                break;
            default:
                icon = 'variable';
                break;
        };
        icon = `icon-${icon}.svg`;
        return {
            dark: this.context.asAbsolutePath(path.join('resources', 'dark', icon)),
            light: this.context.asAbsolutePath(path.join('resources', 'light', icon))
        };
    }

    getTreeItem(node: SymbolNode): TreeItem {
        const { kind } = node.symbol;
        let treeItem = new TreeItem(node.symbol.name);

        if (node.children.length) {

            treeItem.collapsibleState = optsExpandNodes.length && SymbolNode.shouldAutoExpand(kind) ?
                TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed;
        }
        else {

            treeItem.collapsibleState = TreeItemCollapsibleState.None;
        }

        const range = optsDoSelect ? node.symbol.location.range : new Range(
            node.symbol.location.range.start,
            node.symbol.location.range.start
        )

        treeItem.command = {
            command: 'symbolOutline.revealRange',
            title: '',
            arguments: [
                this.editor,
                range
            ]
        };

        treeItem.iconPath = this.getIcon(node);
        return treeItem;
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }
}

function readOpts() {
   let opts = workspace.getConfiguration("symbolOutline");
   optsDoSort = opts.get<boolean>("doSort");
   optsDoSelect = opts.get<boolean>("doSelect");
   optsExpandNodes = convertEnumNames(opts.get<string[]>("expandNodes"));
   optsSortOrder = convertEnumNames(opts.get<string[]>("sortOrder"));
   optsTopLevel = convertEnumNames(opts.get<string[]>("topLevel"));
   optsMarkPrivates = opts.get<boolean>("markPrivates");
}

function convertEnumNames(names:string[]):number[] {
   return names.map(str => {
      let v = SymbolKind[str];
      return typeof v == "undefined" ? -1 : v;
   });
}
