import { Component, type ErrorInfo, type ReactNode } from "react";
import { formatUserFacingError } from "./errorMessage";
import { useStore, type Language } from "./store";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  resetKey?: string | number | null;
  onError?: (error: Error, info: ErrorInfo) => void;
}

const COPY: Record<Language, { title: string; unexpected: string; tryAgain: string }> = {
  cn: { title: "当前视图出现界面错误。", unexpected: "界面遇到意外的渲染错误。", tryAgain: "重试" },
  en: { title: "Something went wrong in this view.", unexpected: "The UI hit an unexpected render error.", tryAgain: "Try again" },
  es: { title: "Algo salió mal en esta vista.", unexpected: "La interfaz encontró un error de renderizado inesperado.", tryAgain: "Reintentar" },
};

/** The boundary may be showing because the store itself failed; never let that throw again. */
function boundaryLanguage(): Language {
  try {
    return useStore.getState().language;
  } catch {
    return "en";
  }
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
    console.error("SomniQ UI render failed", error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const language = boundaryLanguage();
      const copy = COPY[language];
      return this.props.fallback
        ? this.props.fallback(this.state.error, this.reset)
        : (
          <div className="ui-error-boundary" role="alert">
            <strong>{copy.title}</strong>
            <span>{this.state.error.message ? formatUserFacingError(this.state.error, language) : copy.unexpected}</span>
            <button type="button" onClick={this.reset}>{copy.tryAgain}</button>
          </div>
        );
    }

    return this.props.children;
  }
}
