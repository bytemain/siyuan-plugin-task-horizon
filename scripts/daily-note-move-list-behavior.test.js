'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('./i18n-vm-fixture');

const runtime = fs.readFileSync(path.join(__dirname, '../src/task-horizon/main/30-dialogs-and-ui-foundation.js'), 'utf8');
const start = runtime.indexOf('    async function __tmGetBlocksByIdsPreserveOrder(');
const end = runtime.indexOf('    function __tmAddMoveBlockToDailyNoteMenuItem(', start);
assert.ok(start >= 0 && end > start, 'daily note move implementation is present');
const code = runtime.slice(start, end);

function makeScenario({ bottom = false, existingLists = [], failMove = false, failAfterMove = false, staleReadAfterMove = false, failDeletePlaceholder = false, failNewListRead = 0, noteId = 'daily' } = {}) {
    const blocks = new Map();
    const children = new Map();
    const commands = [];
    let next = 0;
    let newListReads = 0;
    const add = (id, type, subtype = '', parent = '', root = parent, content = '') => {
        blocks.set(id, { id, type, subtype, parent_id: parent, root_id: root, content });
        if (parent) (children.get(parent) || children.set(parent, []).get(parent)).push(id);
        if (type === 'd' || type === 'l') children.set(id, []);
    };
    add('source', 'd', '', '', 'source');
    add('daily', 'd', '', '', 'daily');
    if (bottom) add('existing-paragraph', 'p', '', 'daily', 'daily');
    for (const subtype of existingLists) {
        add(`existing-${subtype}`, 'l', subtype, 'daily', 'daily');
        add(`old-${subtype}`, 'i', subtype, `existing-${subtype}`, 'daily');
    }
    if (!bottom) add('existing-paragraph', 'p', '', 'daily', 'daily');
    const sourceItem = (id, subtype) => {
        const list = `source-list-${subtype}`;
        if (!blocks.has(list)) add(list, 'l', subtype, 'source', 'source');
        add(id, 'i', subtype, list, 'source');
    };
    const sourceParagraph = (id) => add(id, 'p', '', 'source', 'source');
    const move = (id, placement) => {
        if (failMove && id.startsWith('item-')) throw new Error('simulated move failure');
        const row = blocks.get(id);
        assert.ok(row, `unknown block ${id}`);
        let parent = placement.parentID;
        let index = 0;
        if (placement.nextID) {
            const anchor = blocks.get(placement.nextID);
            assert.ok(anchor, 'next anchor exists');
            parent = anchor.parent_id;
            index = children.get(parent).indexOf(anchor.id);
        } else if (placement.previousID) {
            const anchor = blocks.get(placement.previousID);
            assert.ok(anchor, 'previous anchor exists');
            parent = anchor.parent_id;
            index = children.get(parent).indexOf(anchor.id) + 1;
        }
        const target = blocks.get(parent);
        assert.ok(target, 'target parent exists');
        if (row.type === 'i') {
            assert.equal(target.type, 'l', 'a list item must never be moved directly into a document');
            assert.equal(target.subtype, row.subtype, 'a list item must keep its list type');
        }
        const old = children.get(row.parent_id);
        const oldIndex = old.indexOf(id);
        old.splice(oldIndex, 1);
        if (row.parent_id === parent && oldIndex < index) index--;
        children.get(parent).splice(index, 0, id);
        row.parent_id = parent;
        row.root_id = target.root_id || parent;
        return parent;
    };
    const remove = (id) => {
        const row = blocks.get(id);
        assert.ok(row, `delete target ${id} exists`);
        for (const child of [...(children.get(id) || [])]) remove(child);
        const siblings = children.get(row.parent_id);
        if (siblings) siblings.splice(siblings.indexOf(id), 1);
        children.delete(id);
        blocks.delete(id);
    };
    const adapter = {
        async insertBlock(parent, markdown, placement) {
            const subtype = markdown.startsWith('- [ ]') ? 't' : markdown.startsWith('1.') ? 'o' : 'u';
            const id = `created-list-${++next}`;
            const placeholder = `placeholder-${next}`;
            add(id, 'l', subtype, parent, 'daily');
            move(id, placement);
            add(placeholder, 'i', subtype, id, 'daily', 'task-horizon-placeholder');
            commands.push({ action: 'create-list', id, subtype });
            return id;
        },
        async deleteBlock(id) {
            commands.push({ action: 'delete', id });
            if (failDeletePlaceholder && id.startsWith('placeholder-')) throw new Error('simulated delete failure');
            remove(id);
        },
        async moveBlock(id, placement) {
            commands.push({ action: 'move-block', id, ...placement });
            const parent = move(id, placement);
            if (failAfterMove && id.startsWith('item-')) throw new Error('simulated late move failure');
            return parent;
        },
    };
    const context = vm.createContext({
        SettingsStore: { data: { newTaskDailyNoteAppendToBottom: bottom } },
        API: {
            getBlocksByIds: async (ids) => ids.map(id => blocks.get(id)).filter(Boolean).reverse(),
            getDocNotebook: async () => 'notebook',
            createDailyNote: async () => noteId,
            getChildBlocks: async id => {
                if (id.startsWith('created-list-') && ++newListReads === failNewListRead) throw new Error('simulated read failure');
                if (id.startsWith('created-list-') && staleReadAfterMove && commands.some(c => c.action === 'move-block' && c.id.startsWith('item-'))) {
                    return (children.get(id) || []).filter(child => child.startsWith('placeholder-')).map(child => ({ ...blocks.get(child) }));
                }
                return (children.get(id) || []).map(child => ({ ...blocks.get(child) }));
            },
        },
        __tmResolveConfiguredDailyNoteNotebookId: () => '',
        __tmResolveProtyleElement: () => null,
        __tmGetDocIdFromProtyle: () => '',
        __tmMoveBlockViaBackendAdapter: async (id, placement) => adapter.moveBlock(id, placement),
        __tmRunInTaskWriterContext: (_, fn) => fn(),
        __tmExecuteTaskCommandGateway: async command => {
            commands.push({ ...command });
            const list = move(command.taskID, command);
            return { value: { placement: { parentListID: list } } };
        },
        __tmInvalidateTasksQueryCacheByDocId: () => {},
        __tmLoadSelectedDocumentsPreserveChecklistScroll: async () => {},
        __tmIsPluginVisibleNow: () => false,
        globalThis: { __tmTaskHorizonBackendAdapter: adapter },
    });
    vm.runInContext(code, context);
    return { blocks, children, commands, sourceItem, sourceParagraph, move, moveToDaily: ids => context.__tmMoveBlocksToDailyNote(ids) };
}

(async () => {
    for (const bottom of [false, true]) {
        const s = makeScenario({ bottom });
        s.sourceItem('item-task-1', 't'); s.sourceItem('item-task-2', 't');
        await s.moveToDaily(['item-task-1', 'item-task-2']);
        const list = s.blocks.get('item-task-1').parent_id;
        assert.equal(s.blocks.get(list).subtype, 't');
        assert.deepEqual(s.children.get(list), ['item-task-1', 'item-task-2']);
        assert.equal(s.blocks.get('item-task-1').root_id, 'daily');
        assert.equal(s.commands.filter(c => c.action === 'move').length, 2);
    }
    {
        const s = makeScenario({ existingLists: ['t', 'u'] });
        s.sourceItem('item-task', 't');
        await s.moveToDaily(['item-task']);
        assert.equal(s.blocks.get('item-task').parent_id, 'existing-t', 'do not send tasks into an unrelated unordered list');
    }
    {
        const s = makeScenario({ bottom: true, existingLists: ['u'] });
        s.sourceParagraph('end-marker');
        s.move('end-marker', { previousID: 'existing-u' });
        s.sourceParagraph('paragraph'); s.sourceItem('item-u', 'u');
        await s.moveToDaily(['paragraph', 'item-u']);
        const list = s.blocks.get('item-u').parent_id;
        assert.notEqual(list, 'existing-u', 'a list in the middle of the document cannot capture a bottom insert');
        assert.deepEqual(s.children.get('daily').slice(-2), ['paragraph', list]);
    }
    for (const subtype of ['u', 'o']) for (const bottom of [false, true]) for (const existing of [false, true]) {
        const s = makeScenario({ bottom, existingLists: existing ? [subtype] : [] });
        s.sourceItem('item-1', subtype); s.sourceItem('item-2', subtype);
        await s.moveToDaily(['item-1', 'item-2']);
        const list = s.blocks.get('item-1').parent_id;
        assert.equal(s.blocks.get(list).subtype, subtype);
        assert.equal(s.blocks.get('item-2').parent_id, list);
        assert.deepEqual(s.children.get(list), existing
            ? (bottom ? [`old-${subtype}`, 'item-1', 'item-2'] : ['item-1', 'item-2', `old-${subtype}`])
            : ['item-1', 'item-2']);
        assert.equal([...s.blocks.keys()].some(id => id.startsWith('placeholder-')), false);
    }
    for (const bottom of [false, true]) {
        const s = makeScenario({ bottom });
        s.sourceParagraph('paragraph-1'); s.sourceItem('item-task', 't'); s.sourceParagraph('paragraph-2');
        await s.moveToDaily(['paragraph-1', 'item-task', 'paragraph-2']);
        const taskList = s.blocks.get('item-task').parent_id;
        const ordered = s.children.get('daily');
        assert.ok(ordered.indexOf('paragraph-1') < ordered.indexOf(taskList));
        assert.ok(ordered.indexOf(taskList) < ordered.indexOf('paragraph-2'));
    }
    for (const subtype of ['u', 'o', 't']) for (const bottom of [false, true]) {
        const s = makeScenario({ bottom });
        s.sourceItem('item-1', subtype); s.sourceParagraph('paragraph'); s.sourceItem('item-2', subtype);
        await s.moveToDaily(['item-1', 'paragraph', 'item-2']);
        const first = s.blocks.get('item-1').parent_id;
        const second = s.blocks.get('item-2').parent_id;
        assert.notEqual(first, second, 'separated items must not be merged across another selected block');
        const ordered = s.children.get('daily');
        assert.ok(ordered.indexOf(first) < ordered.indexOf('paragraph'));
        assert.ok(ordered.indexOf('paragraph') < ordered.indexOf(second));
    }
    for (const subtype of ['u', 'o', 't']) for (const bottom of [false, true]) {
        const s = makeScenario({ bottom, existingLists: [subtype] });
        s.sourceItem('item-1', subtype); s.sourceItem('item-2', subtype);
        s.move('item-1', { previousID: `old-${subtype}` });
        s.move('item-2', { previousID: 'item-1' });
        await s.moveToDaily(['item-1', 'item-2']);
        assert.deepEqual(s.children.get(`existing-${subtype}`), bottom
            ? [`old-${subtype}`, 'item-1', 'item-2']
            : ['item-1', 'item-2', `old-${subtype}`], 'moving items already in today’s note keeps their order');
    }
    {
        const s = makeScenario({ failMove: true });
        s.sourceItem('item-fail', 'u');
        await assert.rejects(s.moveToDaily(['item-fail']), /simulated move failure/);
        assert.equal(s.blocks.get('item-fail').root_id, 'source');
        assert.equal(s.commands.some(c => c.action === 'delete'), false, 'do not delete a list after an uncertain move');
    }
    for (const options of [{ failAfterMove: true }, { failAfterMove: true, staleReadAfterMove: true }, { failDeletePlaceholder: true }, { failNewListRead: 2 }]) {
        const s = makeScenario(options);
        s.sourceItem('item-1', 'u');
        await assert.rejects(s.moveToDaily(['item-1']), /simulated/);
        assert.equal(s.blocks.get('item-1').root_id, 'daily', 'a moved item remains in the daily note after an error');
        assert.ok(s.blocks.has(s.blocks.get('item-1').parent_id), 'do not delete a list containing moved content');
    }
    {
        const s = makeScenario({ failNewListRead: 1 });
        s.sourceItem('item-1', 'u');
        await assert.rejects(s.moveToDaily(['item-1']), /simulated read failure/);
        assert.equal(s.blocks.get('item-1').root_id, 'source');
        assert.equal(s.commands.some(c => c.action === 'delete'), false, 'do not delete a list whose contents could not be confirmed');
    }
    {
        const s = makeScenario({ noteId: '' });
        s.sourceItem('item-1', 't');
        await assert.rejects(s.moveToDaily(['item-1']), /获取日记文档失败/);
        assert.equal(s.commands.length, 0);
    }
    console.log('daily-note list moves, ordering and failure cleanup passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
