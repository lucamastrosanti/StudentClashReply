import React from "react";
import { Sparkles } from "lucide-react";

export function Header() {
  return (
    <header className="border-b bg-white shadow-xs py-4 px-8 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="bg-indigo-600 text-white p-2 rounded-xl shadow-md">
          <Sparkles className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-indigo-950">StudentClash AI</h1>
          <p className="text-xs text-slate-500">University Study Material Restyler & Optimizer</p>
        </div>
      </div>
      <div className="text-xs font-medium px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-full border border-indigo-100 flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-indigo-600 animate-pulse"></span>
        Pipeline v2.0 Active
      </div>
    </header>
  );
}
