// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

library Helper {
    /**
     *  @notice Transfer native token
     */
    function _transferNativeToken(address _to, uint256 _amount) internal {
        // solhint-disable-next-line indent
        (bool success, ) = _to.call{ value: _amount }("");
        require(success, "Fail transfer native");
    }
}
