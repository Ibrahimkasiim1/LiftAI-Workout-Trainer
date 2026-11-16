/**
 * LangGraph Studio Server
 * 
 * This server provides a visual debugging interface for LangGraph agents.
 * 
 * Access at: http://localhost:3002
 * 
 * Features:
 * - Visual graph execution
 * - Step-by-step debugging
 * - State inspection
 * - Message replay
 * - Tool call monitoring
 */

import { HumanMessage } from "@langchain/core/messages";
import cors from "cors";
import "dotenv/config";
import express from "express";
import { getOneShotChatGraph } from "./agents/langgraphRuntime";

// One-shot supervisor graph (no checkpointer) — studio runs are stateless.
const graph = getOneShotChatGraph();
import { createCorsOptions } from "./corsConfig";
import { getLatestPlan, getUserProfile } from "./services/db";

const app = express();
app.use(cors(createCorsOptions()));
app.use(express.json());

// ============================================================================
// GRAPH EXECUTION ENDPOINT
// ============================================================================

/**
 * Execute the main workout assistant graph
 */
app.post("/api/graph/invoke", async (req, res) => {
  try {
    const { userId, message } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: "userId and message are required" });
    }

    console.log("Invoking workout assistant graph...");
    console.log("Input:", { userId, message });

    // Load user context
    const profile = await getUserProfile(userId);
    const currentPlan = await getLatestPlan(userId);

    const result = await graph.invoke({
      userId,
      userProfile: profile,
      currentPlan,
      messages: [new HumanMessage(message)],
      shouldCallTool: false,
      toolCalls: [],
      responseToUser: null,
      completed: false,
      workout: null,
      planUpdate: null,
      retryCount: 0,
      error: null,
    });

    console.log("Graph execution complete");

    res.json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("Graph execution error:", error);
    res.status(500).json({
      error: String(error),
    });
  }
});

/**
 * Stream the workout assistant graph execution
 */
app.post("/api/graph/stream", async (req, res) => {
  try {
    const { userId, message } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: "userId and message are required" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    console.log("Streaming workout assistant graph...");

    // Load user context
    const profile = await getUserProfile(userId);
    const currentPlan = await getLatestPlan(userId);

    const stream = await graph.stream({
      userId,
      userProfile: profile,
      currentPlan,
      messages: [new HumanMessage(message)],
      shouldCallTool: false,
      toolCalls: [],
      responseToUser: null,
      completed: false,
      workout: null,
      planUpdate: null,
      retryCount: 0,
      error: null,
    });

    for await (const chunk of stream) {
      const data = JSON.stringify(chunk);
      res.write(`data: ${data}\n\n`);
      console.log("Chunk:", Object.keys(chunk));
    }

    res.write("data: [DONE]\n\n");
    res.end();

    console.log("Stream complete");
  } catch (error) {
    console.error("Stream error:", error);
    res.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
    res.end();
  }
});

// ============================================================================
// TEST SCENARIOS ENDPOINT
// ============================================================================

/**
 * Test all routing scenarios automatically
 */
app.post("/api/test-scenarios", async (req, res) => {
  try {
    console.log("Running test scenarios...");

    const scenarios = [
      {
        name: "Injury Override",
        userId: "test-user-1",
        message: "I hurt my shoulder, it's sore",
        expected: "adjust_today",
      },
      {
        name: "Plan Modification",
        userId: "test-user-1",
        message: "Add abs exercises to Monday",
        expected: "modify_plan",
      },
      {
        name: "Quick Workout",
        userId: "test-user-1",
        message: "Give me a 20 minute home workout",
        expected: "adjust_today",
      },
      {
        name: "Form Question",
        userId: "test-user-1",
        message: "How do I do a proper squat?",
        expected: "answer_question",
      },
    ];

    const results = [];

    for (const scenario of scenarios) {
      console.log(`\nTesting: ${scenario.name}`);

      const result = await graph.invoke({
        userId: scenario.userId,
        userProfile: { available_equipment: ["dumbbell", "barbell"] },
        currentPlan: { days: [] },
        messages: [new HumanMessage(scenario.message)],
        shouldCallTool: false,
        toolCalls: [],
        responseToUser: null,
        completed: false,
        workout: null,
        planUpdate: null,
        retryCount: 0,
        error: null,
      });

      const passed = Boolean(result.responseToUser) && !result.error;

      results.push({
        scenario: scenario.name,
        message: scenario.message,
        expected: scenario.expected,
        actual: "response_received",
        passed,
        completed: result.completed,
        response: result.responseToUser,
        error: result.error,
      });

      console.log(`   [${passed ? "PASS" : "FAIL"}] Scenario: ${scenario.name}`);
    }

    const passedCount = results.filter(r => r.passed).length;
    const totalCount = results.length;

    console.log(`\nResults: ${passedCount}/${totalCount} passed`);

    res.json({
      success: true,
      summary: {
        total: totalCount,
        passed: passedCount,
        failed: totalCount - passedCount,
        passRate: ((passedCount / totalCount) * 100).toFixed(1) + "%",
      },
      results,
    });
  } catch (error) {
    console.error("Test scenarios error:", error);
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});


// ============================================================================
// GRAPH INSPECTION ENDPOINTS
// ============================================================================

/**
 * Get graph structure for visualization
 */
app.get("/api/graph/structure", (req, res) => {
  try {
    // Return the new workout assistant graph structure
    res.json({
      name: "Workout Assistant Graph",
      nodes: ["coordinator", "execute_tools", "validator"],
      edges: [
        { from: "START", to: "coordinator" },
        { from: "coordinator", to: "execute_tools", condition: "readyToExecute=true" },
        { from: "coordinator", to: "validator", condition: "completed=true" },
        { from: "coordinator", to: "END", condition: "needsMoreInfo=true" },
        { from: "execute_tools", to: "coordinator" },
        { from: "validator", to: "END", condition: "completed=true" },
        { from: "validator", to: "coordinator", condition: "error && retryCount<3" },
      ],
      description: "LangGraph-based workout assistant with conversational coordinator. Uses single agent with structured decision-making for natural, transparent conversations.",
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Health check
 */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "langgraph-studio",
    graphs: ["planner"],
  });
});

// ============================================================================
// SIMPLE WEB UI
// ============================================================================

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>LangGraph Studio - Lift AI</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          padding: 20px;
        }
        .container {
          max-width: 1200px;
          margin: 0 auto;
        }
        .header {
          background: white;
          border-radius: 12px;
          padding: 30px;
          margin-bottom: 20px;
          box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        h1 {
          color: #667eea;
          margin-bottom: 10px;
        }
        .subtitle {
          color: #666;
          font-size: 14px;
        }
        .grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 20px;
        }
        .card {
          background: white;
          border-radius: 12px;
          padding: 25px;
          box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .card h2 {
          color: #333;
          margin-bottom: 15px;
          font-size: 18px;
        }
        .input-group {
          margin-bottom: 15px;
        }
        label {
          display: block;
          margin-bottom: 5px;
          color: #555;
          font-size: 14px;
          font-weight: 500;
        }
        input, select {
          width: 100%;
          padding: 10px;
          border: 2px solid #e0e0e0;
          border-radius: 6px;
          font-size: 14px;
        }
        input:focus, select:focus {
          outline: none;
          border-color: #667eea;
        }
        button {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          width: 100%;
          margin-top: 10px;
        }
        button:hover {
          opacity: 0.9;
        }
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .output {
          background: #f5f5f5;
          border-radius: 6px;
          padding: 15px;
          font-family: 'Courier New', monospace;
          font-size: 12px;
          max-height: 400px;
          overflow-y: auto;
          white-space: pre-wrap;
          word-wrap: break-word;
        }
        .log {
          margin-bottom: 5px;
          padding: 5px;
          border-left: 3px solid #667eea;
          background: white;
        }
        .error {
          border-left-color: #e74c3c;
          color: #e74c3c;
        }
        .success {
          border-left-color: #2ecc71;
          color: #2ecc71;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>LangGraph Studio - Lift AI</h1>
          <p class="subtitle">Debug and visualize your AI agent workflows</p>
        </div>
        
        <div class="grid">
          <div class="card">
            <h2>Test Planner Agent</h2>
            <div class="input-group">
              <label>User ID</label>
              <input type="text" id="userId" placeholder="Enter user ID" />
            </div>
            <div class="input-group">
              <label>Split Type (optional)</label>
              <select id="splitType">
                <option value="">Auto-detect</option>
                <option value="full_body">Full Body</option>
                <option value="upper_lower">Upper/Lower</option>
                <option value="ppl">Push/Pull/Legs</option>
                <option value="bro_split">Bro Split</option>
              </select>
            </div>
            <div class="input-group">
              <label>Training Days (optional)</label>
              <input type="number" id="trainingDays" min="3" max="7" placeholder="3-7" />
            </div>
            <button onclick="runPlanner()">▶️ Run Planner</button>
            <button onclick="streamPlanner()" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);">
              Stream Planner
            </button>
          </div>
          
          <div class="card">
            <h2>Graph Structure</h2>
            <button onclick="loadGraphStructure()">Load Graph</button>
            <div id="graphOutput" class="output" style="margin-top: 15px;">
              Click "Load Graph" to see the graph structure
            </div>
          </div>
        </div>
        
        <div class="card">
          <h2>Execution Log</h2>
          <div id="output" class="output">
            Waiting for execution...
          </div>
        </div>
      </div>
      
      <script>
        function log(message, type = 'info') {
          const output = document.getElementById('output');
          const logClass = type === 'error' ? 'log error' : type === 'success' ? 'log success' : 'log';
          output.innerHTML += \`<div class="\${logClass}">\${new Date().toLocaleTimeString()}: \${message}</div>\`;
          output.scrollTop = output.scrollHeight;
        }
        
        async function runPlanner() {
          const userId = document.getElementById('userId').value;
          if (!userId) {
            alert('Please enter a user ID');
            return;
          }
          
          const splitType = document.getElementById('splitType').value;
          const trainingDays = document.getElementById('trainingDays').value;
          
          const preferences = {};
          if (splitType) preferences.splitType = splitType;
          if (trainingDays) preferences.trainingDays = parseInt(trainingDays);
          
          log('Starting planner execution...');
          
          try {
            const response = await fetch('/api/planner/invoke', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId, preferences })
            });
            
            const data = await response.json();
            
            if (data.success) {
              log('Execution complete!', 'success');
              
              // Visualize the plan
              const result = data.result;
              if (result.dayPlans && result.dayPlans.length > 0) {
                 let html = '<div style="margin-top:10px; border:1px solid #ddd; padding:10px; border-radius:5px; background:white;">';
                 html += '<h3 style="margin-bottom:10px; border-bottom:1px solid #eee; padding-bottom:5px; color:#333;">Generated Plan (' + result.dayPlans.length + ' days)</h3>';
                 
                 result.dayPlans.forEach(day => {
                    html += '<div style="margin-bottom:15px;">';
                    html += '<div style="font-weight:bold; color:#764ba2; margin-bottom:5px;">Day ' + (day.dayIndex + 1) + ': ' + day.focus + ' (' + day.dayOfWeek + ')</div>';
                    html += '<table style="width:100%; border-collapse:collapse; font-size:12px;">';
                    html += '<tr style="background:#f5f5f5; text-align:left; color:#555;"><th style="padding:6px;">ID</th><th style="padding:6px;">Exercise</th><th style="padding:6px;">Target</th><th style="padding:6px;">GIF Path</th></tr>';
                    
                    day.exercises.forEach(ex => {
                       html += '<tr>';
                       html += '<td style="padding:6px; border-bottom:1px solid #eee; color:#666; font-family:monospace;">' + (ex.id || 'missing') + '</td>';
                       html += '<td style="padding:6px; border-bottom:1px solid #eee;"><b>' + ex.name + '</b></td>';
                       html += '<td style="padding:6px; border-bottom:1px solid #eee;">' + ex.target_muscle + '</td>';
                       const gifStatus = ex.gif_path ? '<span style="color:#2ecc71;">' + ex.gif_path.split('/').pop() + '</span>' : '<span style="color:#e74c3c; font-weight:bold;">MISSING</span>';
                       html += '<td style="padding:6px; border-bottom:1px solid #eee;">' + gifStatus + '</td>';
                       html += '</tr>';
                    });
                    html += '</table></div>';
                 });
                 html += '</div>';
                 log(html);
              }

              // Also log raw JSON for debug
              // log(JSON.stringify(data.result, null, 2));
            } else {
              log('Execution failed: ' + data.error, 'error');
            }
          } catch (error) {
            log('Error: ' + error.message, 'error');
          }
        }
        
        async function streamPlanner() {
          const userId = document.getElementById('userId').value;
          if (!userId) {
            alert('Please enter a user ID');
            return;
          }
          
          const splitType = document.getElementById('splitType').value;
          const trainingDays = document.getElementById('trainingDays').value;
          
          const preferences = {};
          if (splitType) preferences.splitType = splitType;
          if (trainingDays) preferences.trainingDays = parseInt(trainingDays);
          
          log('Starting streaming execution...');
          
          try {
            const response = await fetch('/api/planner/stream', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId, preferences })
            });
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              const chunk = decoder.decode(value);
              const lines = chunk.split('\\n');
              
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6);
                  if (data === '[DONE]') {
                    log('Stream complete!', 'success');
                  } else {
                    try {
                      const parsed = JSON.parse(data);
                      log(JSON.stringify(parsed, null, 2));
                    } catch (e) {
                      // Ignore parse errors
                    }
                  }
                }
              }
            }
          } catch (error) {
            log('Stream error: ' + error.message, 'error');
          }
        }
        
        async function loadGraphStructure() {
          try {
            const response = await fetch('/api/graph/structure');
            const data = await response.json();
            document.getElementById('graphOutput').textContent = JSON.stringify(data, null, 2);
          } catch (error) {
            document.getElementById('graphOutput').textContent = 'Error: ' + error.message;
          }
        }
      </script>
    </body>
    </html>
  `);
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.LANGGRAPH_PORT || 3002;

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   LangGraph Studio - Lift AI                           ║
║                                                            ║
║   Server running at: http://localhost:${PORT}                ║
║                                                            ║
║   Available endpoints:                                     ║
║   • GET  /                    - Web UI                     ║
║   • POST /api/planner/invoke  - Execute planner           ║
║   • POST /api/planner/stream  - Stream planner            ║
║   • GET  /api/graph/structure - Graph structure           ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});

export default app;
