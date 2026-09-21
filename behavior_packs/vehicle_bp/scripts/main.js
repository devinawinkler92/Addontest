import { system, world, ItemStack, EntityComponentTypes, BlockPermutation } from "@minecraft/server";

// Configuration limits and constants
const MAX_BLOCKS = 250;
const CONCRETE_SUFFIX = "_concrete";

// Check if a block type is a concrete platform block
function isConcreteBlock(typeId) {
    return typeof typeId === "string" && typeId.endsWith(CONCRETE_SUFFIX);
}

// Convert blockFace input safely into numerical offset vector
function getFaceOffset(blockFace) {
    if (!blockFace) return { x: 0, y: 1, z: 0 };

    const str = String(blockFace).toLowerCase();
    if (str.includes("up")) return { x: 0, y: 1, z: 0 };
    if (str.includes("down")) return { x: 0, y: -1, z: 0 };
    if (str.includes("north")) return { x: 0, y: 0, z: -1 };
    if (str.includes("south")) return { x: 0, y: 0, z: 1 };
    if (str.includes("east")) return { x: 1, y: 0, z: 0 };
    if (str.includes("west")) return { x: -1, y: 0, z: 0 };

    return { x: 0, y: 1, z: 0 };
}

// Flood-fill search from joystick position to collect all connected non-air, non-concrete blocks
function scanStructure(dimension, startPos) {
    const sx = Math.floor(Number(startPos?.x) || 0);
    const sy = Math.floor(Number(startPos?.y) || 0);
    const sz = Math.floor(Number(startPos?.z) || 0);

    const queue = [{ x: sx, y: sy, z: sz }];
    const visited = new Set();
    const blocksData = [];

    visited.add(`${sx},${sy},${sz}`);
    let concreteFound = false;

    while (queue.length > 0 && blocksData.length < MAX_BLOCKS) {
        const curr = queue.shift();
        const block = dimension.getBlock(curr);
        if (!block || block.isAir || block.isLiquid) continue;

        // Check if block rests on concrete
        const blockBelow = dimension.getBlock({ x: curr.x, y: curr.y - 1, z: curr.z });
        if (blockBelow && isConcreteBlock(blockBelow.typeId)) {
            concreteFound = true;
        }

        const dx = curr.x - sx;
        const dy = curr.y - sy;
        const dz = curr.z - sz;

        blocksData.push({
            dx: Math.floor(dx),
            dy: Math.floor(dy),
            dz: Math.floor(dz),
            typeId: block.typeId,
            states: block.permutation.getAllStates()
        });

        // 6-directional neighbors scan
        const neighbors = [
            { x: curr.x + 1, y: curr.y, z: curr.z },
            { x: curr.x - 1, y: curr.y, z: curr.z },
            { x: curr.x, y: curr.y + 1, z: curr.z },
            { x: curr.x, y: curr.y - 1, z: curr.z },
            { x: curr.x, y: curr.y, z: curr.z + 1 },
            { x: curr.x, y: curr.y, z: curr.z - 1 }
        ];

        for (const n of neighbors) {
            const key = `${n.x},${n.y},${n.z}`;
            if (!visited.has(key)) {
                visited.add(key);
                const nb = dimension.getBlock(n);
                if (nb && !nb.isAir && !nb.isLiquid && !isConcreteBlock(nb.typeId)) {
                    queue.push(n);
                }
            }
        }
    }

    return { blocksData, concreteFound };
}

// Clear assembled structure blocks from the world
function clearStructureBlocks(dimension, startPos, blocksData) {
    const sx = Math.floor(Number(startPos?.x) || 0);
    const sy = Math.floor(Number(startPos?.y) || 0);
    const sz = Math.floor(Number(startPos?.z) || 0);

    for (const b of blocksData) {
        const targetPos = {
            x: sx + b.dx,
            y: sy + b.dy,
            z: sz + b.dz
        };
        const block = dimension.getBlock(targetPos);
        if (block) {
            block.setType("minecraft:air");
        }
    }
}

// Convert structure back to world blocks at the vehicle position
function rebuildStructureInWorld(dimension, entityPos, entityRotation, blocksData) {
    const ex = Math.floor(Number(entityPos?.x) || 0);
    const ey = Math.floor(Number(entityPos?.y) || 0);
    const ez = Math.floor(Number(entityPos?.z) || 0);

    const rad = ((Number(entityRotation?.y) || 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    for (const b of blocksData) {
        const rx = Math.round(b.dx * cos - b.dz * sin);
        const rz = Math.round(b.dx * sin + b.dz * cos);

        const targetPos = {
            x: ex + rx,
            y: ey + b.dy,
            z: ez + rz
        };

        const block = dimension.getBlock(targetPos);
        if (block) {
            try {
                let perm = BlockPermutation.resolve(b.typeId);
                if (b.states && Object.keys(b.states).length > 0) {
                    for (const [stateName, stateVal] of Object.entries(b.states)) {
                        try {
                            perm = perm.withState(stateName, stateVal);
                        } catch (e) { }
                    }
                }
                block.setPermutation(perm);
            } catch (err) {
                block.setType(b.typeId);
            }
        }
    }
}

// Trigger structure assembly when placing or interacting with custom:joystick block
world.afterEvents.playerPlaceBlock.subscribe((event) => {
    if (event.block.typeId !== "custom:joystick") return;

    const player = event.player;
    if (!player) return;

    const dimension = player.dimension;
    const blockPos = event.block.location;

    system.run(() => {
        const scanResult = scanStructure(dimension, blockPos);

        if (scanResult.blocksData.length === 0) {
            player.sendMessage("§c[Vehicle Builder] Build blocks above or touching a concrete pad to create a vehicle!");
            return;
        }

        if (!scanResult.concreteFound) {
            player.sendMessage("§c[Vehicle Builder] Vehicle structure must be placed on a Concrete pad!");
            return;
        }

        // Spawn custom:vehicle entity at scan origin
        const spawnPos = { x: blockPos.x + 0.5, y: blockPos.y, z: blockPos.z + 0.5 };
        const vehicleEntity = dimension.spawnEntity("custom:vehicle", spawnPos);

        // Store structure metadata
        const structureJson = JSON.stringify(scanResult.blocksData);
        try {
            vehicleEntity.setDynamicProperty("vehicle_blocks", structureJson);
        } catch (e) { }
        vehicleEntity.nameTag = `Vehicle (${scanResult.blocksData.length} blocks) [Interact to Mount]`;

        // Clear world blocks
        clearStructureBlocks(dimension, blockPos, scanResult.blocksData);

        player.sendMessage("§a[Vehicle Builder] Vehicle Assembled! Right-click / tap the vehicle to mount and drive!");
    });
});

// Main tick loop for driving, flying, water buoyancy
system.runInterval(() => {
    for (const dimension of [world.getDimension("overworld"), world.getDimension("nether"), world.getDimension("the_end")]) {
        const vehicles = dimension.getEntities({ type: "custom:vehicle" });

        for (const vehicle of vehicles) {
            const rideable = vehicle.getComponent(EntityComponentTypes.Rideable);
            const riders = rideable ? rideable.getRiders() : [];

            const currentPos = vehicle.location;
            const blockAtVehicle = dimension.getBlock(currentPos);
            const blockBelow = dimension.getBlock({ x: currentPos.x, y: currentPos.y - 0.5, z: currentPos.z });

            const isInWater = blockAtVehicle?.isLiquid || blockBelow?.isLiquid;

            if (riders.length > 0) {
                const driver = riders[0];
                const viewDirection = driver.getViewDirection();
                const rot = driver.getRotation();

                // Rotate vehicle with rider steering
                vehicle.setRotation({ x: 0, y: rot.y });

                // Check movement input from driver pitch & direction
                const isMovingForward = Math.abs(viewDirection.x) > 0.05 || Math.abs(viewDirection.z) > 0.05;

                let vx = 0;
                let vz = 0;
                let vy = 0;

                if (isMovingForward) {
                    const speed = 0.5;
                    vx = viewDirection.x * speed;
                    vz = viewDirection.z * speed;
                }

                // Vertical flight controls (rocket mode) when looking up or down
                if (viewDirection.y > 0.3) {
                    vy = viewDirection.y * 0.4;
                } else if (viewDirection.y < -0.4 && !isInWater) {
                    vy = viewDirection.y * 0.3;
                }

                // Water buoyancy (pirate ship mode)
                if (isInWater) {
                    const waterBlock = dimension.getBlock({ x: Math.floor(currentPos.x), y: Math.ceil(currentPos.y), z: Math.floor(currentPos.z) });
                    if (waterBlock && waterBlock.isLiquid) {
                        vy = 0.12;
                    }
                }

                if (vx !== 0 || vy !== 0 || vz !== 0) {
                    vehicle.applyImpulse({ x: vx, y: vy, z: vz });
                }

            } else {
                // Unmounted / Parked state: Keep vehicle afloat if in water, otherwise remain stationary
                if (isInWater) {
                    const waterBlock = dimension.getBlock({ x: Math.floor(currentPos.x), y: Math.ceil(currentPos.y), z: Math.floor(currentPos.z) });
                    if (waterBlock && waterBlock.isLiquid) {
                        vehicle.applyImpulse({ x: 0, y: 0.08, z: 0 });
                    }
                }
            }
        }
    }
}, 1);

// Handle entity hurt to restore structure when joystick / vehicle is damaged or removed
world.afterEvents.entityHurt.subscribe((event) => {
    const vehicle = event.hurtEntity;
    if (vehicle.typeId !== "custom:vehicle") return;

    const dimension = vehicle.dimension;
    const pos = vehicle.location;
    let structureDataStr;
    try {
        structureDataStr = vehicle.getDynamicProperty("vehicle_blocks");
    } catch (e) { }

    if (structureDataStr) {
        try {
            const blocksData = JSON.parse(structureDataStr);
            rebuildStructureInWorld(dimension, pos, vehicle.getRotation(), blocksData);
        } catch (e) { }
    }

    // Drop joystick block back
    dimension.spawnItem(new ItemStack("custom:joystick", 1), pos);

    // Remove vehicle entity
    vehicle.remove();
});
