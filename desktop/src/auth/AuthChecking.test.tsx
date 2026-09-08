// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import AuthChecking from "./AuthChecking";
import { useStore } from "../store";

describe("AuthChecking screen", () => {
  beforeEach(() => {
    useStore.setState({ language: "en" });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders English auth verification state", () => {
    useStore.setState({ language: "en" });
    render(<AuthChecking />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Verifying sign-in...")).toBeTruthy();
    expect(screen.getByText("SomniQ Studio")).toBeTruthy();
    expect(screen.getByText("Validating secure session and gateway connection...")).toBeTruthy();
    expect(screen.getByAltText("SomniQ")).toBeTruthy();
  });

  it("renders Chinese auth verification state", () => {
    useStore.setState({ language: "cn" });
    render(<AuthChecking />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("正在验证登录状态...")).toBeTruthy();
    expect(screen.getByText("SomniQ Studio")).toBeTruthy();
    expect(screen.getByText("正在校验安全凭证与网关连接...")).toBeTruthy();
  });
});
