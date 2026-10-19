import {describe, expect, test} from "vitest";
import * as m from "../src/lib/modernExtend";
import type {Definition, Tz} from "../src/lib/types";
import {mockDevice} from "./utils";

describe("combined on/off converter results", () => {
    const fixture = (converter: Tz.Converter) => {
        const device = mockDevice({modelID: "test_light", endpoints: [{ID: 1}, {ID: 2}]});
        const meta = {
            device,
            mapped: {endpoint: () => ({first: 1, second: 2})} as Definition,
            state: {state_first: "OFF", state_second: "OFF"},
            message: {state: "ON"},
            options: {},
            endpoint_name: "first",
        } as Tz.Meta;
        const wrapped = m.withCombinedOnOff({isModernExtend: true, toZigbee: [converter]}).toZigbee[0];
        return {device, meta, wrapped};
    };

    test("preserves a delegated GET result", async () => {
        const result = {state: {state: "ON"}};
        const {device, meta, wrapped} = fixture({key: ["state"], convertGet: async () => result});
        expect(await wrapped.convertGet(device.getEndpoint(1), "state", meta)).toBe(result);
    });

    test("preserves state returned for another device", async () => {
        const otherDevice = "0x0000000000000002";
        const {device, meta, wrapped} = fixture({
            key: ["state"],
            convertSet: async () => ({state: {state: "ON"}, membersState: {[otherDevice]: {state: "OFF"}}}),
        });
        expect(await wrapped.convertSet(device.getEndpoint(1), "state", "ON", meta)).toEqual({
            state: {},
            membersState: {[otherDevice]: {state: "OFF"}, [device.ieeeAddr]: {state: "ON", state_first: "ON"}},
        });
    });
});
