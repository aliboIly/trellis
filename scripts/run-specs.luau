-- Runs the trellis specs under Lune: `lune run scripts/run-specs.luau build/spec.rbxl`.
--
-- The place holds the library and its specs, compiled by rbxtsc and built by Rojo. They run on a
-- small fake of the engine: players who join and leave when a spec asks, remotes that carry
-- payloads between the server and one client in this same process, and stubs for the services
-- trellis uses. Exits with 1 if any spec fails.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local task = require("@lune/task")

local placePath = process.args[1] or "build/spec.rbxl"
local dataModel = roblox.deserializePlace(fs.readFile(placePath))

local function fail(message)
	print("run-specs: " .. message)
	process.exit(1)
end

-- Like an engine signal: each handler runs on its own thread, so an error or a yield in one
-- doesn't reach the code that fired it.
local function signal()
	local connections = {}
	local s = {}
	function s:Connect(fn)
		local entry = { fn = fn }
		table.insert(connections, entry)
		return {
			Disconnect = function()
				local at = table.find(connections, entry)
				if at ~= nil then
					table.remove(connections, at)
				end
			end,
		}
	end
	function s:Fire(...)
		for _, entry in table.clone(connections) do
			task.spawn(entry.fn, ...)
		end
	end
	return s
end

-- Payloads are copied on the way through, like the real network does.
local function copy(value)
	if type(value) ~= "table" then
		return value
	end
	local out = {}
	for key, item in value do
		out[copy(key)] = copy(item)
	end
	return out
end

-- Players are plain tables. trellis only reads their names and ids.
local players = {}
local nextUserId = 0

local function makePlayer(name)
	nextUserId += 1
	return { Name = name, UserId = nextUserId }
end

local Players = { PlayerAdded = signal(), PlayerRemoving = signal() }
function Players:GetPlayers()
	return table.clone(players)
end

local ScriptContext = { Error = signal() }

local RunService = {}
function RunService:IsStudio()
	return true
end
function RunService:IsRunning()
	return true
end
function RunService:IsServer()
	return true
end
function RunService:IsClient()
	return true
end

local stubs = { Players = Players, ScriptContext = ScriptContext, RunService = RunService }

-- Remotes are real instances, so they parent and can be found like real ones. Lune hands out a
-- new userdata for each lookup of an instance, so each remote's state is kept by an id attribute.
local remoteState = {}
local nextRemoteId = 0

local function stateOf(remote)
	local id = remote:GetAttribute("specRemoteId")
	if id == nil then
		nextRemoteId += 1
		id = nextRemoteId
		remote:SetAttribute("specRemoteId", id)
	end
	local state = remoteState[id]
	if state == nil then
		state = { server = signal(), client = signal(), invoke = nil }
		remoteState[id] = state
	end
	return state
end

local harness = {}
local sent = {}

harness.me = makePlayer("me")
table.insert(players, harness.me)

roblox.implementProperty("RemoteEvent", "OnServerEvent", function(remote)
	return stateOf(remote).server
end)
roblox.implementProperty("RemoteEvent", "OnClientEvent", function(remote)
	return stateOf(remote).client
end)
roblox.implementProperty("RemoteFunction", "OnServerInvoke", function(remote)
	return stateOf(remote).invoke
end, function(remote, invoke)
	stateOf(remote).invoke = invoke
end)

roblox.implementMethod("RemoteEvent", "FireServer", function(remote, payload)
	local carried = copy(payload)
	task.defer(function()
		stateOf(remote).server:Fire(harness.me, carried)
	end)
end)
roblox.implementMethod("RemoteEvent", "FireClient", function(remote, player, payload)
	local carried = copy(payload)
	local entry = { contract = remote.Parent.Name, member = remote.Name, to = player.Name, payload = carried }
	table.insert(sent, entry)
	if player == harness.me then
		task.defer(function()
			stateOf(remote).client:Fire(copy(carried))
		end)
	end
end)
-- Like the engine: the server's callback runs on its own thread, so it can yield, and the caller
-- waits for its answer. An error in the callback is raised in the caller too.
local function invokeAs(remote, player, payload, label)
	local invoke = stateOf(remote).invoke
	if invoke == nil then
		error(label .. " has no OnServerInvoke")
	end
	local done, ok, answer = false, false, nil
	task.spawn(function()
		ok, answer = pcall(invoke, player, copy(payload))
		done = true
	end)
	while not done do
		task.wait()
	end
	if not ok then
		error(answer, 0)
	end
	return copy(answer)
end

roblox.implementMethod("RemoteFunction", "InvokeServer", function(remote, payload)
	return invokeAs(remote, harness.me, payload, remote:GetFullName())
end)

-- Lune's instances have no WaitForChild. A wait with no timeout gives up after a few seconds
-- here, since in a spec it means something is broken.
roblox.implementMethod("Instance", "WaitForChild", function(instance, name, timeout)
	local began = os.clock()
	while true do
		local child = instance:FindFirstChild(name)
		if child ~= nil then
			return child
		end
		local elapsed = os.clock() - began
		if timeout ~= nil and elapsed >= timeout then
			return nil
		end
		if timeout == nil and elapsed >= 5 then
			fail("WaitForChild never found " .. instance:GetFullName() .. "." .. name)
		end
		task.wait()
	end
end)

local function remoteOf(contract, member)
	local root = dataModel:GetService("ReplicatedStorage"):FindFirstChild("trellis")
	local folder = root and root:FindFirstChild(contract)
	local remote = folder and folder:FindFirstChild(member)
	if remote == nil then
		error("no remote " .. contract .. "." .. member)
	end
	return remote
end

function harness.join(name)
	local player = makePlayer(name)
	table.insert(players, player)
	Players.PlayerAdded:Fire(player)
	return player
end

function harness.leave(player)
	Players.PlayerRemoving:Fire(player)
	local at = table.find(players, player)
	if at ~= nil then
		table.remove(players, at)
	end
end

function harness.sent()
	return table.clone(sent)
end

function harness.fire(player, contract, member, payload)
	local remote = remoteOf(contract, member)
	local carried = copy(payload)
	task.defer(function()
		stateOf(remote).server:Fire(player, carried)
	end)
end

function harness.invoke(player, contract, member, payload)
	return invokeAs(remoteOf(contract, member), player, payload, contract .. "." .. member)
end

function harness.crash(message)
	ScriptContext.Error:Fire(message, "spec stack", nil)
end

function harness.settle()
	for _ = 1, 3 do
		task.wait()
	end
end

local game = { JobId = "spec", PlaceId = 0, PlaceVersion = 0, harness = harness }
function game:GetService(name)
	return stubs[name] or dataModel:GetService(name)
end
function game:IsLoaded()
	return true
end

local baseEnv = {
	print = print, warn = warn, error = error, assert = assert, pcall = pcall, xpcall = xpcall,
	type = type, typeof = typeof, tostring = tostring, tonumber = tonumber, pairs = pairs,
	ipairs = ipairs, next = next, select = select, unpack = unpack, rawget = rawget,
	rawset = rawset, rawequal = rawequal, setmetatable = setmetatable, getmetatable = getmetatable,
	table = table, string = string, math = math, os = os, coroutine = coroutine, utf8 = utf8,
	bit32 = bit32, debug = debug, task = task, game = game, Instance = roblox.Instance,
}

local loaded = {}
local requireModule

local function envFor(instance)
	-- A flat copy, since luau.load only reads the table's own keys.
	local env = {}
	for key, value in baseEnv do
		env[key] = value
	end
	env.script = instance
	env.require = requireModule
	return env
end

requireModule = function(instance)
	local key = instance:GetFullName()
	local cached = loaded[key]
	if cached ~= nil then
		return cached.value
	end
	local chunk = luau.load(instance.Source, { debugName = key, environment = envFor(instance) })
	local value = chunk()
	loaded[key] = { value = value }
	return value
end

local build = dataModel:GetService("ReplicatedStorage"):FindFirstChild("build")
local tests = build and build:FindFirstChild("tests")
local main = tests and tests:FindFirstChild("main")
if main == nil then
	fail("no ReplicatedStorage.build.tests.main in " .. placePath)
end

local ok, result = pcall(function()
	return requireModule(main).run()
end)
if not ok then
	fail("the specs could not run: " .. tostring(result))
end
if result ~= 0 then
	fail(result .. " failed")
end
