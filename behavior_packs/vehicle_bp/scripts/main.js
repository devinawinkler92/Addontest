import { system, world, ItemStack, EntityComponentTypes, BlockPermutation } from "@minecraft/server";

// Configuration limits and constants
const MAX_BLOCKS = 250;
const CONCRETE_SUFFIX = "_concrete";

// Check if a block type is a concrete platform block
function isConcreteBlock(typeId) {
    return typeof typeId === "string" && typeId.endsWith(CONCRETE_SUFFIX);
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

// Place real blocks in world at current position
function placeStructureBlocks(dimension, entityPos, entityRotation, blocksData) {
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

// Protect assembled vehicle blocks from being broken unless joystick is removed
world.beforeEvents.playerBreakBlock.subscribe((event) => {
    const player = event.player;
    if (!player) return;

    const dimension = player.dimension;
    const blockLoc = event.block.location;

    const nearbyVehicles = dimension.getEntities({
        type: "custom:vehicle",
        location: blockLoc,
        maxDistance: 12
    });

    if (nearbyVehicles.length > 0) {
        // If player is trying to break the Joystick itself, allow it & disassemble
        if (event.block.typeId === "custom:joystick") {
            const vehicle = nearbyVehicles[0];
            let structureDataStr;
            try {
                structureDataStr = vehicle.getDynamicProperty("vehicle_blocks");
            } catch (e) { }

            if (structureDataStr) {
                try {
                    const blocksData = JSON.parse(structureDataStr);
                    // Free blocks from vehicle mode
                } catch (e) { }
            }
            vehicle.remove();
            player.sendMessage("§e[Vehicle Builder] Vehicle disassembled! Blocks are now editable again.");
            return;
        }

        // Otherwise block editing while assembled
        event.cancel = true;
        player.sendMessage("§c[Vehicle Builder] Vehicle is assembled! Break the Joystick block to edit blocks again.");
    }
});

// Activate vehicle mode when player places or interacts with joystick block
world.beforeEvents.itemUseOn.subscribe((event) => {
    const player = event.source;
    if (!player) return;

    const dimension = player.dimension;
    const blockLoc = event.block.location;
    const block = dimension.getBlock(blockLoc);

    if (!block || block.typeId !== "custom:joystick") return;

    system.run(() => {
        // Check if there's already a vehicle entity at this position to re-mount
        const nearbyVehicles = dimension.getEntities({
            type: "custom:vehicle",
            location: blockLoc,
            maxDistance: 2
        });

        if (nearbyVehicles.length > 0) {
            const vehicle = nearbyVehicles[0];
            const rideable = vehicle.getComponent(EntityComponentTypes.Rideable);
            if (rideable) {
                rideable.addRider(player);
                player.sendMessage("§a[Vehicle Builder] Mounted vehicle! Look & walk (W/A/S/D) to drive!");
            }
            return;
        }

        // Scan structure blocks
        const scanResult = scanStructure(dimension, blockLoc);

        if (scanResult.blocksData.length === 0) {
            player.sendMessage("§c[Vehicle Builder] Build blocks above or touching a concrete pad to create a vehicle!");
            return;
        }

        if (!scanResult.concreteFound) {
            player.sendMessage("§c[Vehicle Builder] Vehicle structure must be placed on a Concrete pad!");
            return;
        }

        // Spawn custom:vehicle entity at scan origin
        const spawnPos = { x: blockLoc.x + 0.5, y: blockLoc.y, z: blockLoc.z + 0.5 };
        const vehicleEntity = dimension.spawnEntity("custom:vehicle", spawnPos);

        // Store structure metadata into Dynamic Property
        const structureJson = JSON.stringify(scanResult.blocksData);
        try {
            vehicleEntity.setDynamicProperty("vehicle_blocks", structureJson);
        } catch (e) { }
        vehicleEntity.nameTag = `Vehicle (${scanResult.blocksData.length} blocks)`;

        // Keep real blocks placed at world location so the vehicle is 100% visible!
        placeStructureBlocks(dimension, blockLoc, { x: 0, y: 0, z: 0 }, scanResult.blocksData);

        // Auto mount player
        const rideable = vehicleEntity.getComponent(EntityComponentTypes.Rideable);
        if (rideable) {
            rideable.addRider(player);
        }

        player.sendMessage("§a[Vehicle Builder] Vehicle Assembled! Walk/move joystick controls to drive! Shift to unmount.");
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

                // Detect actual player joystick movement (W/A/S/D velocity)
                let driverVel = { x: 0, y: 0, z: 0 };
                try {
                    driverVel = driver.getVelocity() || { x: 0, y: 0, z: 0 };
                } catch (e) { }

                const isMovingJoystick = Math.abs(driverVel.x) > 0.02 || Math.abs(driverVel.z) > 0.02;

                const pitch = rot.x;
                const isLookingUpToFly = pitch < -25;
                const isLookingDownToDescend = pitch > 35;

                let vx = 0;
                let vz = 0;
                let vy = 0;

                // Move ONLY when player moves joystick
                if (isMovingJoystick) {
                    const speed = 0.25;
                    vx = viewDirection.x * speed;
                    vz = viewDirection.z * speed;
                }

                if (isLookingUpToFly && isMovingJoystick) {
                    vy = 0.25;
                } else if (isLookingDownToDescend && isMovingJoystick && !isInWater) {
                    vy = -0.2;
                }

                if (isInWater && isMovingJoystick) {
                    vy = 0.06;
                }

                if (vx !== 0 || vy !== 0 || vz !== 0) {
                    vehicle.applyImpulse({ x: vx, y: vy, z: vz });
                }

            }
        }
    }
}, 1);

// RESTORE BLOCKS WHEN BREAKING JOYSTICK
world.afterEvents.entityHurt.subscribe((event) => {
    const vehicle = event.hurtEntity;
    if (vehicle.typeId !== "custom:vehicle") return;

    const dimension = vehicle.dimension;
    const pos = vehicle.location;

    dimension.spawnItem(new ItemStack("custom:joystick", 1), pos);
    vehicle.remove();
});
