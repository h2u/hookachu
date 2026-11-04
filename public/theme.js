try {
  const theme = localStorage.getItem("hookachu-theme") || "auto";
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" ||
      (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches),
  );
} catch {
  document.documentElement.classList.toggle(
    "dark",
    matchMedia("(prefers-color-scheme: dark)").matches,
  );
}
