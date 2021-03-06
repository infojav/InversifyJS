import interfaces from "../interfaces/interfaces";
import Binding from "../bindings/binding";
import BindingScope from "../bindings/binding_scope";
import Lookup from "./lookup";
import plan from "../planning/planner";
import resolve from "../resolution/resolver";
import * as ERROR_MSGS from "../constants/error_msgs";
import * as METADATA_KEY from "../constants/metadata_keys";
import BindingToSyntax from "../syntax/binding_to_syntax";
import TargetType from "../planning/target_type";
import { getServiceIdentifierAsString } from "../utils/serialization";
import ContainerSnapshot from "./container_snapshot";
import guid from "../utils/guid";

class Container implements interfaces.Container {

    public guid: string;
    public readonly options: interfaces.ContainerOptions;
    private _middleware: interfaces.Next;
    private _bindingDictionary: interfaces.Lookup<interfaces.Binding<any>>;
    private _snapshots: Array<interfaces.ContainerSnapshot>;
    private _parentContainer: interfaces.Container;

    public static merge(container1: interfaces.Container, container2: interfaces.Container): interfaces.Container {

        let container = new Container();
        let bindingDictionary: interfaces.Lookup<interfaces.Binding<any>> = (<any>container)._bindingDictionary;
        let bindingDictionary1: interfaces.Lookup<interfaces.Binding<any>> = (<any>container1)._bindingDictionary;
        let bindingDictionary2: interfaces.Lookup<interfaces.Binding<any>> = (<any>container2)._bindingDictionary;

        function copyDictionary(
            origing: interfaces.Lookup<interfaces.Binding<any>>,
            destination: interfaces.Lookup<interfaces.Binding<any>>
        ) {

            origing.traverse((key, value) => {
                value.forEach((binding) => {
                    destination.add(binding.serviceIdentifier, binding.clone());
                });
            });

        }

        copyDictionary(bindingDictionary1, bindingDictionary);
        copyDictionary(bindingDictionary2, bindingDictionary);

        return container;

    }

    public constructor(containerOptions?: interfaces.ContainerOptions) {

        if (containerOptions !== undefined) {

            if (typeof containerOptions !== "object") {
                throw new Error(`${ERROR_MSGS.KERNEL_OPTIONS_MUST_BE_AN_OBJECT}`);
            } else if (containerOptions.defaultScope === undefined) {
                throw new Error(`${ERROR_MSGS.KERNEL_OPTIONS_INVALID_DEFAULT_SCOPE}`);
            } else if (containerOptions.defaultScope !== "singleton" && containerOptions.defaultScope !== "transient") {
                throw new Error(`${ERROR_MSGS.KERNEL_OPTIONS_INVALID_DEFAULT_SCOPE}`);
            }

            this.options = {
                defaultScope: containerOptions.defaultScope
            };

        } else {
            this.options = {
                defaultScope: "transient"
            };
        }

        this.guid = guid();
        this._bindingDictionary = new Lookup<interfaces.Binding<any>>();
        this._snapshots = [];
        this._middleware = null;
        this._parentContainer = null;
    }

    public load(...modules: interfaces.ContainerModule[]): void {
        let getBindFunction = (moduleId: string) => {
            return (serviceIdentifier: interfaces.ServiceIdentifier<any>) => {
                let _bind = this.bind.bind(this);
                let bindingToSyntax = _bind(serviceIdentifier);
                (<any>bindingToSyntax)._binding.moduleId = moduleId;
                return bindingToSyntax;
            };
        };
        modules.forEach((module) => {
            let bindFunction = getBindFunction(module.guid);
            module.registry(bindFunction);
        });
    }

    public unload(...modules: interfaces.ContainerModule[]): void {

        let conditionFactory = (expected: any) => (item: interfaces.Binding<any>): boolean => {
            return item.moduleId === expected;
        };

        modules.forEach((module) => {
            let condition = conditionFactory(module.guid);
            this._bindingDictionary.removeByCondition(condition);
        });

    }

    // Regiters a type binding
    public bind<T>(serviceIdentifier: interfaces.ServiceIdentifier<T>): interfaces.BindingToSyntax<T> {
        let defaultScope = (this.options.defaultScope === "transient") ? BindingScope.Transient : BindingScope.Singleton;
        let binding = new Binding<T>(serviceIdentifier, defaultScope);
        this._bindingDictionary.add(serviceIdentifier, binding);
        return new BindingToSyntax<T>(binding);
    }

    // Removes a type binding from the registry by its key
    public unbind(serviceIdentifier: interfaces.ServiceIdentifier<any>): void {
        try {
            this._bindingDictionary.remove(serviceIdentifier);
        } catch (e) {
            throw new Error(`${ERROR_MSGS.CANNOT_UNBIND} ${getServiceIdentifierAsString(serviceIdentifier)}`);
        }
    }

    // Removes all the type bindings from the registry
    public unbindAll(): void {
        this._bindingDictionary = new Lookup<Binding<any>>();
    }

    // Allows to check if there are bindings available for serviceIdentifier
    public isBound(serviceIdentifier: interfaces.ServiceIdentifier<any>): boolean {
        return this._bindingDictionary.hasKey(serviceIdentifier);
    }

    public snapshot(): void {
        this._snapshots.push(ContainerSnapshot.of(this._bindingDictionary.clone(), this._middleware));
    }

    public restore(): void {
        if (this._snapshots.length === 0) {
            throw new Error(ERROR_MSGS.NO_MORE_SNAPSHOTS_AVAILABLE);
        }
        let snapshot = this._snapshots.pop();
        this._bindingDictionary = snapshot.bindings;
        this._middleware = snapshot.middleware;
    }

    public set parent (container: interfaces.Container) {
        this._parentContainer = container;
    }

    public get parent() {
        return this._parentContainer;
    }

    public applyMiddleware(...middlewares: interfaces.Middleware[]): void {
        let initial: interfaces.Next = (this._middleware) ? this._middleware : this._planAndResolve();
        this._middleware = middlewares.reduce((prev, curr) => {
            return curr(prev);
        }, initial);
    }

    // Resolves a dependency by its runtime identifier
    // The runtime identifier must be associated with only one binding
    // use getAll when the runtime identifier is associated with multiple bindings
    public get<T>(serviceIdentifier: interfaces.ServiceIdentifier<T>): T {
        return this._get<T>(false, TargetType.Variable, serviceIdentifier) as T;
    }

    public getTagged<T>(serviceIdentifier: interfaces.ServiceIdentifier<T>, key: string, value: any): T {
        return this._get<T>(false, TargetType.Variable, serviceIdentifier, key, value) as T;
    }

    public getNamed<T>(serviceIdentifier: interfaces.ServiceIdentifier<T>, named: string): T {
        return this.getTagged<T>(serviceIdentifier, METADATA_KEY.NAMED_TAG, named);
    }

    // Resolves a dependency by its runtime identifier
    // The runtime identifier can be associated with one or multiple bindings
    public getAll<T>(serviceIdentifier: interfaces.ServiceIdentifier<T>): T[] {
        return this._get<T>(true, TargetType.Variable, serviceIdentifier) as T[];
    }

    public getAllTagged<T>(serviceIdentifier: interfaces.ServiceIdentifier<T>, key: string, value: any): T[] {
        return this._get<T>(true, TargetType.Variable, serviceIdentifier, key, value) as T[];
    }

    public getAllNamed<T>(serviceIdentifier: interfaces.ServiceIdentifier<T>, named: string): T[] {
        return this.getAllTagged<T>(serviceIdentifier, METADATA_KEY.NAMED_TAG, named);
    }

    // Prepares arguments required for resolution and 
    // delegates resolution to _middleware if available
    // otherwise it delegates resoltion to _planAndResolve
    private _get<T>(
        isMultiInject: boolean,
        targetType: TargetType,
        serviceIdentifier: interfaces.ServiceIdentifier<any>,
        key?: string,
        value?: any
    ): (T|T[]) {

        let result: (T|T[]) = null;

        let args: interfaces.NextArgs = {
            contextInterceptor: (context: interfaces.Context) => { return context; },
            isMultiInject: isMultiInject,
            key: key,
            serviceIdentifier: serviceIdentifier,
            targetType: targetType,
            value: value
        };

        if (this._middleware) {
            result = this._middleware(args);
            if (result === undefined || result === null) {
                throw new Error(ERROR_MSGS.INVALID_MIDDLEWARE_RETURN);
            }
        } else {
            result = this._planAndResolve<T>()(args);
        }

        return result;
    }

    // Planner creates a plan and Resolver resolves a plan
    // one of the jobs of the Container is to links the Planner
    // with the Resolver and that is what this function is about
    private _planAndResolve<T>(): (args: interfaces.NextArgs) => (T|T[]) {
        return (args: interfaces.NextArgs) => {
            let context = plan(
                this, args.isMultiInject, args.targetType, args.serviceIdentifier, args.key, args.value
            );
            let result = resolve<T>(args.contextInterceptor(context));
            return result;
        };
    }
}

export default Container;
