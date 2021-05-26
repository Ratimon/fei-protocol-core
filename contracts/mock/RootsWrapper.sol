// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import "../utils/Roots.sol";

contract RootsWrapper {
    using Roots for uint;

    function cubeRoot(uint x) public pure returns (uint) {
        return x.cubeRoot();
    }

    function sqrt(uint x) public pure returns (uint) {
        return x.sqrt();
    }
}