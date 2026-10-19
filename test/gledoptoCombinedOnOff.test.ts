import {beforeEach, describe, expect, test, vi} from "vitest";
import {prepareDefinition} from "../src";
import {definitions} from "../src/devices/gledopto";
import * as store from "../src/lib/store";
import type {Fz, KeyValue, Tz} from "../src/lib/types";
import {mockDevice} from "./utils";

describe("combined on/off through the device converters", () => {
    const definition = prepareDefinition(definitions.find((definition) => definition.model === "GL-C-008-2ID"));
    const endpoints = {rgb: 11, cct: 15};
    const commandOptions = {disableDefaultResponse: false};
    let device: ReturnType<typeof mockDevice>;
    let meta: Tz.Meta;
    const converter = definition.toZigbee.find((converter) => converter.key.includes("brightness"));
    const allOff = {state_rgb: "OFF", state_cct: "OFF"};

    beforeEach(() => {
        store.clear();
        device = mockDevice({
            modelID: "test_light",
            endpoints: Object.values(endpoints).map((Id) => ({ID: Id, meta: {onLevelSupported: false}})),
        });
        meta = {device, mapped: definition, state: {...allOff}, message: {}, options: {}, publish: vi.fn(), endpoint_name: undefined};
    });

    const set = async (message: KeyValue, endpoint?: keyof typeof endpoints) => {
        meta = {...meta, message, endpoint_name: endpoint};
        const key = Object.keys(message)[0];
        const result = await converter.convertSet(device.getEndpoint(endpoints[endpoint] ?? 11), key, message[key], meta);
        // Apply Zigbee2MQTT's suffixing/filtering to state and merge the already-qualified membersState.
        // This compares the published values without requiring one converter return representation.
        const published: KeyValue = {};
        if (meta.options.optimistic !== false) {
            for (const [property, value] of Object.entries(result?.state ?? {})) {
                const name = endpoint ? `${property}_${endpoint}` : property;
                const filtered =
                    Array.isArray(meta.options.filtered_optimistic) &&
                    meta.options.filtered_optimistic.some((pattern) => new RegExp(pattern).test(name));
                if (!filtered) published[name] = value;
            }
            Object.assign(published, result?.membersState?.[device.ieeeAddr]);
        }
        return published;
    };
    const report = (Id: number, onOff: number, state: KeyValue) => {
        const converter = definition.fromZigbee.find((converter) => converter.cluster === "genOnOff");
        const msg = {device, endpoint: device.getEndpoint(Id), data: {onOff}, type: "attributeReport", cluster: "genOnOff"} as Fz.Message;
        return converter.convert(definition, msg, vi.fn(), {}, {device, state, deviceExposesChanged: vi.fn()});
    };

    test.each([
        ["OFF with the other channel unknown", {}, 11, 0, undefined],
        ["ON with the other channel unknown", {}, 11, 1, "ON"],
        ["cached OFF with the other channel unknown", {state_rgb: "OFF"}, 11, 0, undefined],
        ["all channels OFF", {state_cct: "OFF"}, 11, 0, "OFF"],
        ["RGB OFF while CCT is ON", {state_cct: "ON"}, 11, 0, "ON"],
        ["CCT OFF while RGB is ON", {state_rgb: "ON"}, 15, 0, "ON"],
    ])("aggregates reports without treating unknown channels as OFF: %s", async (_description, state, id, onOff, combined) => {
        const result = await report(id as number, onOff as number, state as KeyValue);
        const property = id === 11 ? "state_rgb" : "state_cct";
        expect(result).toEqual({[property]: onOff ? "ON" : "OFF", ...(combined === undefined ? {} : {state: combined})});
    });

    test("also aggregates reports from an existing multiEndpoint definition", async () => {
        const mapped = {...definition, meta: {...definition.meta, multiEndpoint: true}};
        const converter = mapped.fromZigbee.find((converter) => converter.cluster === "genOnOff");
        const msg = {device, endpoint: device.getEndpoint(11), data: {onOff: 0}, type: "attributeReport", cluster: "genOnOff"} as Fz.Message;
        expect(
            await converter.convert(mapped, msg, vi.fn(), {}, {device, state: {...allOff, state_cct: "ON"}, deviceExposesChanged: vi.fn()}),
        ).toEqual({state_rgb: "OFF", state: "ON"});
    });

    test.each(["ON", "OFF"])("fans out generic %s to every named endpoint", async (state) => {
        const result = await set({state});
        for (const endpoint of device.endpoints)
            expect(endpoint.command).toHaveBeenCalledExactlyOnceWith("genOnOff", state.toLowerCase(), {}, commandOptions);
        expect(result).toMatchObject({state, state_rgb: state, state_cct: state});
    });

    test.each([0, 1])("generic TOGGLE reads every channel before choosing a common state: %s", async (onOff) => {
        for (const endpoint of device.endpoints) endpoint.read.mockResolvedValue({onOff: endpoint.ID === 15 ? onOff : 0});
        meta.state = {state: onOff ? "OFF" : "ON"};
        await set({state: "TOGGLE"});
        for (const endpoint of device.endpoints) {
            expect(endpoint.read).toHaveBeenCalledExactlyOnceWith("genOnOff", ["onOff"]);
            expect(endpoint.command).toHaveBeenCalledExactlyOnceWith("genOnOff", onOff ? "off" : "on", {}, commandOptions);
        }
    });

    test.each([undefined, 2, "1"])("does not send TOGGLE commands after an invalid read: %s", async (onOff) => {
        device.getEndpoint(11).read.mockResolvedValue({onOff: 0});
        device.getEndpoint(15).read.mockResolvedValue({onOff});
        await expect(set({state: "TOGGLE"})).rejects.toThrow();
        for (const endpoint of device.endpoints) expect(endpoint.command).not.toHaveBeenCalled();
    });

    test("channel commands use channel state and keep the aggregate ON while another channel is ON", async () => {
        meta.state = {state: "ON", state_rgb: "OFF", state_cct: "ON"};
        const result = await set({state: "TOGGLE"}, "rgb");
        expect(result).toMatchObject({state: "ON", state_rgb: "ON"});
        expect(device.getEndpoint(15).command).not.toHaveBeenCalled();
    });

    test("multiple channel commands share pending updates without changing the input cache", async () => {
        const original = meta.state;
        await set({state: "ON"}, "rgb");
        const result = await set({state: "OFF"}, "cct");
        expect(result).toMatchObject({state: "ON", state_cct: "OFF"});
        expect(original).toEqual(allOff);
    });

    test("generic brightness stays on the default endpoint", async () => {
        await set({brightness: 100});
        expect(device.getEndpoint(11).command).toHaveBeenCalledOnce();
        expect(device.getEndpoint(15).command).not.toHaveBeenCalled();
    });

    test("explicit generic power carries timing to all channels and brightness only to the default endpoint", async () => {
        await set({state: "ON", brightness: 100, transition: 2});
        expect(device.getEndpoint(11).command).toHaveBeenCalledWith(
            "genLevelCtrl",
            "moveToLevelWithOnOff",
            expect.objectContaining({level: 100, transtime: 66}),
            commandOptions,
        );
        expect(device.getEndpoint(15).command).toHaveBeenCalledWith(
            "genLevelCtrl",
            "moveToLevelWithOnOff",
            expect.objectContaining({level: 254, transtime: 66}),
            commandOptions,
        );
    });

    test.each([undefined, "cct"])("GET reads the appropriate endpoints: %s", async (endpoint) => {
        await converter.convertGet(device.getEndpoint(endpoints[endpoint] ?? 11), "state", {...meta, endpoint_name: endpoint});
        for (const ep of device.endpoints) expect(ep.read).toHaveBeenCalledTimes(endpoint === undefined || ep.ID === 15 ? 1 : 0);
    });

    test("attempts remaining channels after a failure and publishes only successful changes", async () => {
        device.getEndpoint(11).command.mockRejectedValue(new Error("failed"));
        await expect(set({state: "ON"})).rejects.toThrow("failed");
        expect(device.getEndpoint(15).command).toHaveBeenCalledOnce();
        expect(meta.publish).toHaveBeenCalledExactlyOnceWith({state_cct: "ON", state: "ON"});
    });

    test("does not publish a partial optimistic update when optimistic is disabled", async () => {
        meta.options = {optimistic: false};
        device.getEndpoint(11).command.mockRejectedValue(new Error("failed"));
        await expect(set({state: "ON"})).rejects.toThrow("failed");
        expect(meta.publish).not.toHaveBeenCalled();
    });

    test("respects aggregate optimistic filtering", async () => {
        meta.options = {filtered_optimistic: ["^state$"]};
        const result = await set({state: "ON"}, "rgb");
        expect(result).toEqual({state_rgb: "ON"});
    });
});
