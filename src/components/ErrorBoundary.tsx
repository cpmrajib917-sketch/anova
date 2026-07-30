// @ts-nocheck
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught React Error:', error, errorInfo);
  }

  public handleReload = () => {
    this.setState({ hasError: false, error: undefined });
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#07090e] text-white flex flex-col items-center justify-center p-6 text-center">
          <div className="bg-[#0a0d14] border border-rose-500/20 p-8 rounded-3xl max-w-md w-full shadow-2xl space-y-5">
            <div className="w-14 h-14 bg-rose-500/10 border border-rose-500/30 rounded-2xl flex items-center justify-center mx-auto text-rose-400">
              <AlertTriangle size={28} />
            </div>
            
            <div className="space-y-2">
              <h2 className="text-xl font-black uppercase tracking-wider text-white">Temporary Application Glitch</h2>
              <p className="text-xs text-gray-400 leading-relaxed">
                The application encountered an unexpected runtime state. Don't worry, your progress and data are safe!
              </p>
            </div>

            {this.state.error?.message && (
              <div className="bg-black/50 border border-white/5 p-3 rounded-xl font-mono text-[10px] text-rose-300 truncate">
                {this.state.error.message}
              </div>
            )}

            <button
              onClick={this.handleReload}
              className="w-full bg-primary hover:bg-primary/90 text-black py-3 rounded-xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 transition-all cursor-pointer shadow-lg shadow-primary/20"
            >
              <RefreshCw size={14} />
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
