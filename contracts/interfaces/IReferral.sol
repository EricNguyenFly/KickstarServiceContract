// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

interface IReferral {
    function getReferrer(address _account) external returns (uint256);
}
