---@meta

-- QB Studio's curated Qbox (qbx_core) LuaCATS definitions. This pack is
-- maintained separately from the generated FiveM and RedM engine definitions.
--
-- Qbox is the maintained QB successor and is accessed through exports rather
-- than a shared core object: `exports.qbx_core:GetCoreObject` does not exist.
-- Job and gang grades are numbers here, unlike QBCore where they are strings.

---@alias QbxPlayerId integer
---@alias QbxMoneyType 'cash'|'bank'|'crypto'
---@alias QbxNotifyType 'inform'|'error'|'success'|'warning'

---@class QbxJobGrade
---@field name string
---@field level integer

---@class QbxJob
---@field name string
---@field label string
---@field payment number
---@field type? string
---@field onduty boolean
---@field isboss boolean
---@field grade QbxJobGrade

---@class QbxGang
---@field name string
---@field label string
---@field isboss boolean
---@field grade QbxJobGrade

---@class QbxCharInfo
---@field firstname string
---@field lastname string
---@field birthdate string
---@field nationality string
---@field cid integer
---@field gender integer
---@field backstory string
---@field phone string
---@field account string
---@field card string

---@class QbxLicences
---@field id boolean
---@field driver boolean
---@field weapon boolean

---@class QbxMetadata
---@field health integer
---@field armor integer
---@field hunger number
---@field thirst number
---@field stress number
---@field isdead boolean
---@field inlaststand boolean
---@field ishandcuffed boolean
---@field tracker boolean
---@field injail integer
---@field jailitems table
---@field status table
---@field phone table
---@field bloodtype string
---@field licences QbxLicences
---@field fingerprint string
---@field callsign string
---@field criminalrecord table
---@field inside table
---@field phonedata table

---@class QbxMoney
---@field cash number
---@field bank number
---@field crypto number

---@class QbxPlayerData
---@field citizenid string
---@field license string
---@field name string
---@field source QbxPlayerId
---@field money QbxMoney
---@field charinfo QbxCharInfo
---@field job QbxJob
---@field gang QbxGang
---@field jobs table<string, integer>
---@field gangs table<string, integer>
---@field position vector4
---@field metadata QbxMetadata

---@class QbxPlayer
---@field PlayerData QbxPlayerData
---@field Offline boolean

---@class QbxClientPlayer
---@field PlayerData QbxPlayerData

--- Client-side player state, kept in sync by the playerdata module.
---@type QbxClientPlayer
QBX = {}

---@class QbxLib
---@field getVehiclePlate fun(vehicle: integer): string?
---@field getCardinalDirection fun(entity: integer): string
---@field spawnVehicle fun(options: table): integer

--- Shared client/server helper library exposed by qbx_core.
---@type QbxLib
qbx = {}

---@class QbxCoreExports
--- Server player lookups. Always nil-check the result.
---@field GetPlayer fun(source: QbxPlayerId): QbxPlayer?
---@field GetPlayerByCitizenId fun(citizenid: string): QbxPlayer?
---@field GetPlayerByUserId fun(userId: integer): QbxPlayer?
---@field GetPlayerByPhone fun(number: string): QbxPlayer?
---@field GetOfflinePlayer fun(citizenid: string): QbxPlayer?
---@field GetQBPlayers fun(): table<QbxPlayerId, QbxPlayer>
---@field GetPlayersData fun(): QbxPlayerData[]
---@field GetSource fun(identifier: string): QbxPlayerId?
---@field GetUserId fun(identifier: string): integer?
---@field SearchPlayers fun(query: table): QbxPlayer[]
--- Player data, metadata and charinfo.
---@field SetPlayerData fun(source: QbxPlayerId, key: string, value: any): boolean
---@field UpdatePlayerData fun(source: QbxPlayerId)
---@field GetMetadata fun(source: QbxPlayerId|string, key: string): any
---@field SetMetadata fun(source: QbxPlayerId|string, key: string, value: any)
---@field SetCharInfo fun(source: QbxPlayerId, key: string, value: any)
--- Jobs and gangs. Runtime creation only; persisted definitions live in shared data.
---@field CreateJob fun(name: string, job: table)
---@field CreateJobs fun(jobs: table<string, table>)
---@field RemoveJob fun(name: string)
---@field CreateGangs fun(gangs: table<string, table>)
---@field RemoveGang fun(name: string)
---@field GetJobs fun(): table<string, table>
---@field GetGangs fun(): table<string, table>
---@field GetDutyCountJob fun(job: string): integer, QbxPlayerId[]
---@field GetDutyCountType fun(type: string): integer, QbxPlayerId[]
--- Group membership. Grades are numbers.
---@field HasPrimaryGroup fun(source: QbxPlayerId|string, group?: string): boolean
---@field HasGroup fun(source: QbxPlayerId|table, groups?: string|table<string, integer>): boolean
---@field GetGroups fun(source?: QbxPlayerId): table<string, integer>
--- Shared data.
---@field GetVehiclesByName fun(): table<string, table>
---@field GetWeapons fun(): table<string, table>
---@field GetCoreVersion fun(): string
--- Items, session and moderation.
---@field CreateUseableItem fun(item: string, handler: fun(source: QbxPlayerId, item: table))
---@field CanUseItem fun(item: string): boolean
---@field CreatePlayer fun(playerData: table, offline?: boolean): QbxPlayer?
---@field Logout fun(source: QbxPlayerId)
---@field Save fun(source: QbxPlayerId)
---@field ExploitBan fun(source: QbxPlayerId, reason: string)
---@field IsPlayerBanned fun(source: QbxPlayerId): boolean, string?
---@field IsWhitelisted fun(source: QbxPlayerId): boolean
---@field SetPlayerBucket fun(source: QbxPlayerId, bucket: integer): boolean
---@field GetPlayersInBucket fun(bucket: integer): QbxPlayerId[]
--- Notifications wrap ox_lib. The server form takes a source first; the client
--- form omits it.
---@field Notify fun(source: QbxPlayerId|string, text?: string|table, notifyType?: QbxNotifyType, duration?: integer, subTitle?: string, position?: string, style?: table, icon?: string, iconColor?: string)

-- The platform pack owns the `exports` global, so this pack deliberately does
-- not redeclare it. Annotate the export table where you use it to get full
-- completion on the interface above:
--
--   ---@type QbxCoreExports
--   local core = exports.qbx_core
--   local player = core:GetPlayer(source)
