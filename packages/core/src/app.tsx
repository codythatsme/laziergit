export function App() {
  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <box
        title=" laziergit "
        style={{
          width: 48,
          height: 7,
          border: true,
          borderStyle: "rounded",
          borderColor: "#7aa2f7",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <text content="A lighter, extensible git TUI" style={{ fg: "#c0caf5" }} />
        <text content="M0 scaffold is running" style={{ fg: "#9ece6a", marginTop: 1 }} />
      </box>
    </box>
  )
}
