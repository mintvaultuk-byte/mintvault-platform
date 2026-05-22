import { Component, type ReactNode } from "react";
import GradientButton from "@/components/ui/gradient-button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#0a0e1a] text-white px-6">
          <div className="text-center max-w-md">
            <h1 className="text-2xl font-bold text-[#D4AF37] mb-4">Something went wrong</h1>
            <p className="text-[#d4d4d4] text-sm mb-6">
              An unexpected error occurred. Please refresh the page to continue.
            </p>
            <GradientButton height="42px" className="gradient-btn-filled" onClick={() => window.location.reload()}>
              Refresh page
            </GradientButton>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
