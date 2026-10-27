export const SHARED_DOCUMENT_LUA = `
local function gwRenderDocument(doc, selected, selectedBody)
  local pieces = {}

  for index, name in ipairs(doc.names) do
    local fn = doc.functions[name]
    table.insert(pieces, doc.parts[index])

    if selected == "*" then
      table.insert(pieces, fn.body)
    elseif name == selected then
      table.insert(pieces, selectedBody)
    else
      table.insert(pieces, fn.official)
    end
  end

  table.insert(pieces, doc.parts[#doc.names + 1])
  return table.concat(pieces)
end

local function gwReleaseFunction(doc, fn)
  local lock = fn.lock
  if not lock then return end

  if lock.hacker then
    fn.body = lock.baseline
    fn.revision = fn.revision + 1
  end

  fn.lock = nil
  doc.revision = doc.revision + 1
end

local function gwCleanDocument(room, private, now)
  local doc = private.collaboration
  if not doc then return false end

  local active = {}
  for _, player in ipairs(room.players or {}) do
    if not player.eliminated then
      active[player.id] = true
    end
  end

  local changed = false

  for _, name in ipairs(doc.names) do
    local fn = doc.functions[name]
    local lock = fn.lock

    if lock then
      if room.phase ~= "IN_PROGRESS" or not active[lock.owner] then
        gwReleaseFunction(doc, fn)
        changed = true
      elseif lock.checking and now >= lock.checking.expiresAt then
        lock.checking = nil
        doc.revision = doc.revision + 1
        changed = true
      end
    end
  end

  return changed
end

local function gwAcceptRepair(private, playerId, source, version, now)
  local doc = private.collaboration
  if not doc then return false end

  for _, name in ipairs(doc.names) do
    local fn = doc.functions[name]
    local lock = fn.lock
    local check = lock and lock.checking

    if lock and lock.owner == playerId and check then
      if lock.hacker or
         check.source ~= source or
         check.baseVersion ~= version or
         check.revision ~= fn.revision or
         now >= check.expiresAt or
         gwRenderDocument(doc, name, fn.body) ~= source then
        return false
      end

      fn.official = fn.body
      fn.accepted = true
      fn.lock = nil
      doc.revision = doc.revision + 1
      return true
    end
  end

  return false
end
`;