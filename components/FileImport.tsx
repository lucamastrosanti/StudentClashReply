"use client";

import React, { useRef } from "react";
import { AlertCircle, FileText, Upload } from "lucide-react";

interface FileImportProps {
  dragOver: boolean;
  error: string | null;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onFilesChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

/**
 * Step 1 of the flow: the user drops one or more study materials. Nothing is
 * processed here, the files are only queued in the list below.
 */
export function FileImport({
  dragOver,
  error,
  onDragOver,
  onDragLeave,
  onDrop,
  onFilesChange,
}: FileImportProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="bg-white rounded-2xl shadow-xl border border-slate-100 p-6 sm:p-8">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-indigo-950">Import your study material</h2>
        <p className="text-sm text-slate-500 mt-1">
          Add one or more files now, then restyle each of them whenever you want.
        </p>
      </div>

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Add study material files"
        className={`cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-all ${
          dragOver
            ? "border-indigo-500 bg-indigo-50/70 scale-[1.01]"
            : "border-slate-300 bg-slate-50 hover:border-indigo-400 hover:bg-indigo-50/40"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.pptx"
          onChange={onFilesChange}
          className="hidden"
        />

        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
          <Upload className="w-7 h-7" />
        </div>
        <p className="text-sm font-semibold text-slate-800">
          Click to add files or drag and drop
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Multiple .PDF or .PPTX files, up to 25 MB each (legacy .PPT must be re-saved as .PPTX)
        </p>
        <div className="mt-4 inline-flex items-center gap-2 text-xs font-medium text-slate-400">
          <FileText className="w-3.5 h-3.5" />
          Lecture slides, handouts and notes
        </div>
      </div>

      {error ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
