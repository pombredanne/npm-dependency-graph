/*
 * Copyright (C) 2018 TypeFox
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 */

import { injectable, inject, optional } from "inversify";
import {
    LocalModelSource, ComputedBoundsAction, TYPES, IActionDispatcher, ActionHandlerRegistry, ViewerOptions,
    PopupModelFactory, IStateAwareModelProvider, SGraphSchema, ILogger, SelectAction, FitToScreenAction,
    SelectAllAction, Action, SelectCommand, SelectAllCommand
} from "sprotty/lib";
import { IGraphGenerator } from "./graph-generator";
import { ElkGraphLayout } from "./graph-layout";
import { DependencyGraphNodeSchema, isNode } from "./graph-model";
import { DependencyGraphFilter } from "./graph-filter";

@injectable()
export class DepGraphModelSource extends LocalModelSource {

    loadIndicator?: (loadStatus: boolean) => void;

    constructor(@inject(TYPES.IActionDispatcher) actionDispatcher: IActionDispatcher,
        @inject(TYPES.ActionHandlerRegistry) actionHandlerRegistry: ActionHandlerRegistry,
        @inject(TYPES.ViewerOptions) viewerOptions: ViewerOptions,
        @inject(IGraphGenerator) public readonly graphGenerator: IGraphGenerator,
        @inject(DependencyGraphFilter) protected readonly graphFilter: DependencyGraphFilter,
        @inject(ElkGraphLayout) protected readonly elk: ElkGraphLayout,
        @inject(TYPES.ILogger) protected readonly logger: ILogger,
        @inject(TYPES.PopupModelFactory)@optional() popupModelFactory?: PopupModelFactory,
        @inject(TYPES.StateAwareModelProvider)@optional() modelProvider?: IStateAwareModelProvider
    ) {
        super(actionDispatcher, actionHandlerRegistry, viewerOptions, popupModelFactory, modelProvider);
    }

    protected initialize(registry: ActionHandlerRegistry): void {
        super.initialize(registry);

        registry.register(SelectCommand.KIND, this);
        registry.register(SelectAllCommand.KIND, this);
    }

    start(): Promise<void> {
        return this.setModel(this.graphGenerator.graph);
    }

    select(elementIds: string[]): Promise<void> {
        if (elementIds.length > 0) {
            return this.actionDispatcher.dispatch(new SelectAction(elementIds.filter(id => {
                const element = this.graphGenerator.index.getById(id);
                return isNode(element) && !element.hidden;
            })));
        } else {
            return Promise.resolve();
        }
    }

    center(elementIds: string[]): Promise<void> {
        if (elementIds.length > 0) {
            return this.actionDispatcher.dispatch(<FitToScreenAction>{
                kind: 'fit',
                elementIds: elementIds.filter(id => {
                    const element = this.graphGenerator.index.getById(id);
                    return isNode(element) && !element.hidden;
                }),
                padding: 20,
                maxZoom: 1,
                animate: true
            });
        } else {
            return Promise.resolve();
        }
    }

    async filter(text: string): Promise<void> {
        this.graphFilter.setFilter(text);
        this.graphFilter.refresh(this.graphGenerator.graph, this.graphGenerator.index);
        this.actionDispatcher.dispatch(new SelectAllAction(false));
        const center = this.model.children!.filter(c => isNode(c) && !c.hidden).map(c => c.id);
        await this.updateModel();
        this.center(center);
    }

    async createNode(name: string, version?: string): Promise<void> {
        const isNew = this.graphGenerator.index.getById(name) === undefined;
        const node = this.graphGenerator.generateNode(name, version);
        if (isNew) {
            await this.updateModel();
            this.select([node.id]);
        }
    }

    async resolveNodes(nodes: DependencyGraphNodeSchema[]): Promise<void> {
        if (nodes.every(n => !!n.hidden || !!n.resolved)) {
            this.center(nodes.map(n => n.id));
            return;
        }
        if (this.loadIndicator) {
            this.loadIndicator(true);
        }

        const promises: Promise<DependencyGraphNodeSchema[]>[] = [];
        const center: string[] = [];
        for (const node of nodes) {
            if (!node.hidden) {
                try {
                    promises.push(this.graphGenerator.resolveNode(node));
                } catch (error) {
                    node.error = error.toString();
                }
                center.push(node.id);
            }
        }
        await Promise.all(promises)
        this.graphFilter.refresh(this.graphGenerator.graph, this.graphGenerator.index);
        await this.updateModel();

        if (this.loadIndicator) {
            this.loadIndicator(false);
        }
        this.center(center);
    }

    async resolveGraph(): Promise<void> {
        if (this.loadIndicator) {
            this.loadIndicator(true);
        }

        let nodes = this.model.children!.filter(c => isNode(c) && !c.resolved) as DependencyGraphNodeSchema[];
        while (nodes.length > 0) {
            const newNodes: DependencyGraphNodeSchema[] = [];
            const promises: Promise<void>[] = [];
            for (const node of nodes) {
                try {
                    promises.push(this.graphGenerator.resolveNode(node).then(result => {
                        newNodes.push(...result);
                    }));
                } catch (error) {
                    node.error = error.toString();
                }
            }
            await Promise.all(promises);
            nodes = newNodes;
        }
        this.graphFilter.refresh(this.graphGenerator.graph, this.graphGenerator.index);
        const center = this.model.children!.filter(c => isNode(c) && !c.hidden).map(c => c.id);
        await this.updateModel();

        if (this.loadIndicator) {
            this.loadIndicator(false);
        }
        this.center(center);
    }

    clear(): Promise<void> {
        for (const element of this.model.children!) {
            this.graphGenerator.index.remove(element);
        }
        this.model.children = [];
        this.graphFilter.setFilter('');
        return this.updateModel();
    }

    handle(action: Action): void {
        switch (action.kind) {
            case SelectCommand.KIND:
                this.handleSelect(action as SelectAction);
                break;
            case SelectAllCommand.KIND:
                this.handleSelectAll(action as SelectAllAction);
                break;
            default:
                super.handle(action);
        }
    }

    protected handleSelect(action: SelectAction) {
        const nodes: DependencyGraphNodeSchema[] = [];
        action.selectedElementsIDs.forEach(id => {
            const element = this.graphGenerator.index.getById(id);
            if (element && element.type === 'node')
                nodes.push(element as DependencyGraphNodeSchema);
        });
        if (nodes.length > 0) {
            this.resolveNodes(nodes);
        }
    }

    protected handleSelectAll(action: SelectAllAction) {
        if (action.select) {
            const nodes: DependencyGraphNodeSchema[] = [];
            this.graphGenerator.index.all().forEach(element => {
                if (element.type === 'node')
                    nodes.push(element as DependencyGraphNodeSchema);
            });
            if (nodes.length > 0) {
                this.resolveNodes(nodes);
            }
        }
    }

    protected handleComputedBounds(action: ComputedBoundsAction): void {
        const root = this.currentRoot;
        const index = this.graphGenerator.index;
        for (const b of action.bounds) {
            const element = index.getById(b.elementId);
            if (element !== undefined)
                this.applyBounds(element, b.newBounds);
        }
        if (action.alignments !== undefined) {
            for (const a of action.alignments) {
                const element = index.getById(a.elementId);
                if (element !== undefined)
                    this.applyAlignment(element, a.newAlignment);
            }
        }

        // Compute a layout with elkjs
        this.elk.layout(root as SGraphSchema, index).then(() => {
            this.doSubmitModel(root, true);
        }).catch(error => {
            this.logger.error(this, error.toString());
            this.doSubmitModel(root, true);
        });
    }

}
