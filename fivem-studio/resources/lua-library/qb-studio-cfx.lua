---@meta

-- QB Studio's compact LuaCATS library for QBCore and the APIs shared by
-- FiveM/RedM. It supplements the selected server workspace; it is never loaded
-- by FXServer and deliberately avoids pretending to cover every game native.

---@alias CfxHash integer
---@alias CfxPlayerId integer
---@alias QBCoreMoneyType 'cash'|'bank'|'crypto'

---@class vector2
---@field x number
---@field y number
---@operator add(vector2|number): vector2
---@operator sub(vector2|number): vector2
---@operator mul(vector2|number): vector2
---@operator div(vector2|number): vector2
---@operator len: number

---@class vector3: vector2
---@field z number
---@operator add(vector3|number): vector3
---@operator sub(vector3|number): vector3
---@operator mul(vector3|number): vector3
---@operator div(vector3|number): vector3

---@class vector4: vector3
---@field w number
---@operator add(vector4|number): vector4
---@operator sub(vector4|number): vector4
---@operator mul(vector4|number): vector4
---@operator div(vector4|number): vector4

---@param x number
---@param y number
---@return vector2
function vector2(x, y) end

---@param x number
---@param y number
---@param z number
---@return vector3
function vector3(x, y, z) end

---@param x number
---@param y number
---@param z number
---@param w number
---@return vector4
function vector4(x, y, z, w) end

---@param x number
---@param y? number
---@param z? number
---@param w? number
---@return number|vector2|vector3|vector4
function vector(x, y, z, w) end

vec = vector
vec2 = vector2
vec3 = vector3
vec4 = vector4

---@param value string
---@return CfxHash
function joaat(value) end

---@param value string
---@return CfxHash
function GetHashKey(value) end

---@param handler fun()
function CreateThread(handler) end

---@param milliseconds integer
function Wait(milliseconds) end

---@param milliseconds integer
---@param handler fun()
---@return integer timerId
function SetTimeout(milliseconds, handler) end

---@param timerId integer
function ClearTimeout(timerId) end

---@param eventName string
---@param handler? fun(...)
function RegisterNetEvent(eventName, handler) end

---@param eventName string
---@param handler fun(...)
---@return integer handlerId
function AddEventHandler(eventName, handler) end

---@param handlerId integer
function RemoveEventHandler(handlerId) end

---@param eventName string
---@param ... any
function TriggerEvent(eventName, ...) end

---@param eventName string
---@param ... any
function TriggerServerEvent(eventName, ...) end

---@param eventName string
---@param playerId CfxPlayerId
---@param ... any
function TriggerClientEvent(eventName, playerId, ...) end

---@param commandName string
---@param handler fun(source: CfxPlayerId, args: string[], rawCommand: string)
---@param restricted? boolean
function RegisterCommand(commandName, handler, restricted) end

---@param command string
function ExecuteCommand(command) end

---@return string
function GetCurrentResourceName() end

---@return string?
function GetInvokingResource() end

---@param resourceName string
---@return 'missing'|'started'|'starting'|'stopped'|'stopping'|'uninitialized'|'unknown'
function GetResourceState(resourceName) end

---@param resourceName string
---@return boolean
function StartResource(resourceName) end

---@param resourceName string
---@return boolean
function StopResource(resourceName) end

---@return string[]
function GetPlayers() end

---@param playerId CfxPlayerId
---@param reason string
function DropPlayer(playerId, reason) end

---@param name string
---@param defaultValue string
---@return string
function GetConvar(name, defaultValue) end

---@param name string
---@param defaultValue integer
---@return integer
function GetConvarInt(name, defaultValue) end

---@param name string
---@param defaultValue boolean
---@return boolean
function GetConvarBool(name, defaultValue) end

---@param name string
---@param value string
function SetConvar(name, value) end

---@param url string
---@param callback fun(statusCode: integer, body: string, headers: table<string, string>, errorData?: string)
---@param method? string
---@param data? string
---@param headers? table<string, string>
---@param options? table
function PerformHttpRequest(url, callback, method, data, headers, options) end

---@class CfxCitizen
---@field CreateThread fun(handler: fun())
---@field Wait fun(milliseconds: integer)
---@field SetTimeout fun(milliseconds: integer, handler: fun()): integer
---@field InvokeNative fun(hash: CfxHash, ...): any
Citizen = {}

---@class CfxPromise
---@field resolve fun(self: CfxPromise, value?: any)
---@field reject fun(self: CfxPromise, reason?: any)
---@field next fun(self: CfxPromise, onFulfilled?: fun(value: any): any, onRejected?: fun(reason: any): any): CfxPromise

---@class CfxPromiseLibrary
---@field new fun(): CfxPromise
promise = {}

---@class CfxJsonLibrary
---@field encode fun(value: any, options?: table): string
---@field decode fun(value: string): any
json = {}

---@class CfxExports
---@field [string] any
---@overload fun(exportName: string, handler: fun(...)): nil
exports = {}

---@return integer
function PlayerPedId() end

---@param playerId CfxPlayerId
---@return integer
function GetPlayerPed(playerId) end

---@param entity integer
---@return vector3
function GetEntityCoords(entity) end

---@param entity integer
---@return boolean
function DoesEntityExist(entity) end

---@param model CfxHash|string
function RequestModel(model) end

---@param model CfxHash|string
---@return boolean
function HasModelLoaded(model) end

---@param entity integer
function DeleteEntity(entity) end

---@return integer
function GetGameTimer() end

---@class QBCorePlayerData
---@field citizenid string
---@field cid integer
---@field source CfxPlayerId
---@field license string
---@field name string
---@field money table<QBCoreMoneyType, number>
---@field charinfo table
---@field job table
---@field gang table
---@field metadata table
---@field position vector3|vector4|table
---@field items table[]

---@class QBCorePlayerFunctions
---@field UpdatePlayerData fun(self: QBCorePlayerFunctions)
---@field SetJob fun(self: QBCorePlayerFunctions, job: string, grade?: integer|string): boolean
---@field SetGang fun(self: QBCorePlayerFunctions, gang: string, grade?: integer|string): boolean
---@field SetJobDuty fun(self: QBCorePlayerFunctions, onDuty: boolean)
---@field SetPlayerData fun(self: QBCorePlayerFunctions, key: string, value: any)
---@field SetMetaData fun(self: QBCorePlayerFunctions, key: string, value: any)
---@field GetMetaData fun(self: QBCorePlayerFunctions, key: string): any
---@field AddMoney fun(self: QBCorePlayerFunctions, moneyType: QBCoreMoneyType, amount: number, reason?: string): boolean
---@field RemoveMoney fun(self: QBCorePlayerFunctions, moneyType: QBCoreMoneyType, amount: number, reason?: string): boolean
---@field SetMoney fun(self: QBCorePlayerFunctions, moneyType: QBCoreMoneyType, amount: number, reason?: string): boolean
---@field GetMoney fun(self: QBCorePlayerFunctions, moneyType: QBCoreMoneyType): number
---@field AddItem fun(self: QBCorePlayerFunctions, item: string, amount: integer, slot?: integer|boolean, info?: table, reason?: string): boolean
---@field RemoveItem fun(self: QBCorePlayerFunctions, item: string, amount: integer, slot?: integer|boolean, reason?: string): boolean
---@field GetItemByName fun(self: QBCorePlayerFunctions, item: string): table?
---@field GetItemBySlot fun(self: QBCorePlayerFunctions, slot: integer): table?
---@field Save fun(self: QBCorePlayerFunctions)
---@field Logout fun(self: QBCorePlayerFunctions)

---@class QBCorePlayer
---@field PlayerData QBCorePlayerData
---@field Functions QBCorePlayerFunctions

---@class QBCoreServerFunctions
---@field GetPlayer fun(source: CfxPlayerId): QBCorePlayer?
---@field GetPlayerByCitizenId fun(citizenId: string): QBCorePlayer?
---@field GetPlayerByPhone fun(phone: string): QBCorePlayer?
---@field GetQBPlayers fun(): table<CfxPlayerId, QBCorePlayer>
---@field GetPlayers fun(): CfxPlayerId[]
---@field CreateCallback fun(name: string, handler: fun(source: CfxPlayerId, callback: fun(...), ...))
---@field TriggerCallback fun(name: string, source: CfxPlayerId, callback: fun(...), ...)
---@field HasPermission fun(source: CfxPlayerId, permission: string|string[]): boolean
---@field AddPermission fun(source: CfxPlayerId, permission: string)
---@field RemovePermission fun(source: CfxPlayerId, permission?: string)
---@field Notify fun(source: CfxPlayerId, text: string|table, notifyType?: string, duration?: integer)

---@class QBCoreClientFunctions
---@field GetPlayerData fun(callback?: fun(data: QBCorePlayerData)): QBCorePlayerData
---@field GetCoords fun(entity: integer): vector4
---@field HasItem fun(items: string|string[]|table<string, integer>, amount?: integer): boolean
---@field Notify fun(text: string|table, notifyType?: string, duration?: integer, subTitle?: string, notifyPosition?: string, notifyStyle?: table, notifyIcon?: string, notifyIconColor?: string)
---@field TriggerCallback fun(name: string, callback: fun(...), ...)
---@field GetVehicles fun(): integer[]
---@field GetPlayers fun(): CfxPlayerId[]
---@field GetClosestPlayer fun(coords?: vector3): CfxPlayerId, number
---@field GetClosestVehicle fun(coords?: vector3): integer, number
---@field SpawnVehicle fun(model: CfxHash|string, callback: fun(vehicle: integer), coords?: vector4, isNetworked?: boolean)
---@field DeleteVehicle fun(vehicle: integer)
---@field Progressbar fun(name: string, label: string, duration: integer, useWhileDead: boolean, canCancel: boolean, disableControls: table, animation?: table, prop?: table, propTwo?: table, onFinish?: fun(), onCancel?: fun())

---@class QBCoreShared
---@field Items table<string, table>
---@field Jobs table<string, table>
---@field Gangs table<string, table>
---@field Vehicles table<string, table>
---@field Weapons table<string, table>
---@field StarterItems table<string, integer>
---@field SplitStr fun(value: string, delimiter?: string): string[]
---@field Trim fun(value: string): string
---@field Round fun(value: number, decimalPlaces?: integer): number

---@class QBCoreCommands
---@field Add fun(name: string|string[], help: string, arguments: table[], argsRequired: boolean, callback: fun(source: CfxPlayerId, args: string[]), permission?: string, ...: any)
---@field Refresh fun(source: CfxPlayerId)

---@class QBCoreObject
---@field Functions QBCoreServerFunctions|QBCoreClientFunctions
---@field Shared QBCoreShared
---@field Commands QBCoreCommands
---@field Players table<CfxPlayerId, QBCorePlayer>
---@field ServerCallbacks table<string, function>
QBCore = {}

-- Server event handlers receive this Cfx global.
---@type CfxPlayerId
source = 0
